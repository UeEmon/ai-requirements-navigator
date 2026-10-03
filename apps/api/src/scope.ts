/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 要件定義で決めることの補足（機能 F11）。
 * - プロジェクトの決まり（確定に承認が必要か）
 * - 用語集（AIの下書き＋人の編集、要件文の表記ゆれの検出）
 * - 受け入れ基準（何を満たせば受け入れるか）と、テスト結果に照らした判定
 * - レビューと承認（承認した内容と、いまの要件が同じかを指紋で確かめる）
 * - 確定版の差分（版どうし、または確定版といまの要件。影響するテスト・ストーリー・画面つき）
 */
import {
  AcceptanceCriteria,
  DEFAULT_ACCEPTANCE,
  diffSnapshots,
  evaluateAcceptance,
  generateGlossary,
  glossaryFromDesign,
  GlossaryTerm,
  mergeGlossary,
  snapshotFingerprint,
  summarizeUmlModel,
  termVariants,
  type SnapshotItem,
  type TestCase,
} from "@arn/ai-core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import type { ImplementationContext } from "./implementation.js";
import { usageOf, type AcceptanceSheet, type GlossarySheet, type Project, type Requirement, type Review } from "./store.js";

const SettingsInput = z.object({
  approvalRequired: z.boolean().default(false),
  requiredApprovals: z.number().int().min(1).max(5).default(1),
});
const GlossaryInput = z.object({ terms: z.array(GlossaryTerm).max(200) });
const AcceptanceInput = z.object({ criteria: AcceptanceCriteria });
const CheckInput = z.object({ id: z.string().min(1).max(20), checked: z.boolean() });
const ReviewInput = z.object({ note: z.string().max(2000).default("") });
const DecideInput = z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().max(2000).default("") });

export const snapshotOf = (rs: Requirement[]): SnapshotItem[] =>
  rs.map((r) => ({ code: r.code, type: r.type, title: r.title, description: r.description, priority: r.priority, version: r.version }));

export type ApprovalStatus = "approved" | "pending" | "rejected" | "stale" | "none";

export function scope(ctx: ImplementationContext, deps: { testsOf: (p: Project) => Promise<{ cases: TestCase[] }>; statusOf: (p: Project) => Promise<{ rows: Array<{ code: string; type: string; tests: { total: number; status: string; failed: number } }> }> }) {
  const { store } = ctx;

  /* ---------- 用語集 ---------- */

  async function glossary(p: Project) {
    const sheet = await store.getProjectSheet<GlossarySheet>(p.id, "glossary");
    const terms = sheet?.data.terms ?? [];
    const reqs = await store.listRequirements(p.id);
    const variants = termVariants(reqs.map((r) => ({ code: r.code, title: r.title })), terms);
    return { terms, variants, updatedAt: sheet?.updatedAt ?? null, updatedBy: sheet?.updatedBy ?? null };
  }

  async function generate(p: Project, actor: string) {
    const ids = [...new Set([...p.aiConfig.generatorIds, ...(p.aiConfig.evaluatorId ? [p.aiConfig.evaluatorId] : [])])];
    const b = await ctx.budget(p.orgId, ids);
    const usable = ids.filter((id) => !b.excluded.has(id));
    if (!usable.length) throw new HTTPException(429, { message: `使えるAIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const providers = await ctx.providersOf(p.orgId, usable);
    if (p.confidential && providers.some((x) => !x.isLocal)) throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    const reqs = await store.listRequirements(p.id);
    if (!reqs.length) throw new HTTPException(400, { message: "要件がまだありません" });
    const uml = await store.latestUmlModel(p.id);
    const current = (await glossary(p)).terms;
    const seeded = mergeGlossary(current, glossaryFromDesign(uml?.model));
    let r: Awaited<ReturnType<typeof generateGlossary>>;
    try {
      r = await generateGlossary(providers, { projectName: p.name, reqs: reqs.map((x) => ({ code: x.code, title: x.title })), design: uml ? summarizeUmlModel(uml.model) : "", current: seeded }, ctx.timeoutMs);
    } catch (e) {
      const labels = await ctx.labelsOf(p.orgId);
      const f = ((e as { failures?: Array<{ providerId: string; reason: string }> }).failures ?? []).map((x) => `${labels.get(x.providerId) ?? x.providerId}: ${x.reason}`);
      throw new HTTPException(502, { message: `${(e as Error).message}${f.length ? `（${f.join(" / ")}）` : ""}` });
    }
    await store.addUsage({ orgId: p.orgId, providerId: r.providerId, projectId: p.id, ...usageOf(r.usage) });
    const terms = mergeGlossary(seeded, r.terms);
    await store.saveProjectSheet<GlossarySheet>(p.id, "glossary", { terms }, actor);
    await audit(store, { orgId: p.orgId, actor, action: "ai.glossary", targetType: "project", targetId: p.id, detail: { terms: terms.length, added: terms.length - current.length, provider: r.providerId } });
    return glossary(p);
  }

  /* ---------- 受け入れ基準 ---------- */

  async function acceptance(p: Project) {
    const sheet = await store.getProjectSheet<AcceptanceSheet>(p.id, "acceptance");
    const criteria = sheet ? AcceptanceCriteria.parse(sheet.data) : DEFAULT_ACCEPTANCE;
    const st = await deps.statusOf(p);
    const pri = new Map((await store.listRequirements(p.id)).map((r) => [r.code, r.priority]));
    const open = (await store.listQuestions(p.id)).filter((q) => q.status === "open").length;
    const ev = evaluateAcceptance(criteria, st.rows.map((r) => ({ ...r, priority: pri.get(r.code) })), open);
    return { defined: !!sheet, criteria, evaluation: ev, updatedAt: sheet?.updatedAt ?? null, updatedBy: sheet?.updatedBy ?? null };
  }

  /* ---------- レビューと承認 ---------- */

  async function currentFingerprint(p: Project) {
    return snapshotFingerprint(await store.listRequirements(p.id));
  }

  const reviewView = (r: Review, fp: string) => ({
    ...r,
    snapshot: undefined,
    requirements: r.snapshot.length,
    approvals: r.decisions.filter((d) => d.decision === "approve").length,
    /** 依頼した後に要件が変わったか */
    stale: r.fingerprint !== fp,
  });

  async function approval(p: Project): Promise<{ required: boolean; status: ApprovalStatus; review: Review | null }> {
    const required = !!p.settings?.approvalRequired;
    const reviews = await store.listReviews(p.id);
    const last = reviews.find((r) => r.status !== "withdrawn") ?? null;
    if (!last) return { required, status: "none", review: null };
    const fp = await currentFingerprint(p);
    if (last.status === "approved") return { required, status: last.fingerprint === fp ? "approved" : "stale", review: last };
    if (last.status === "rejected") return { required, status: "rejected", review: last };
    return { required, status: last.fingerprint === fp ? "pending" : "stale", review: last };
  }

  /** 確定の前の確認: 承認が必要なプロジェクトでは、いまの要件の内容で承認されていること */
  async function approvalGate(p: Project) {
    const a = await approval(p);
    return { ok: !a.required || a.status === "approved", ...a };
  }

  /* ---------- 差分 ---------- */

  async function diff(p: Project, from?: number, to?: number) {
    const history = await store.listBaselines(p.id);
    const byVersion = (v: number) => {
      const b = history.find((x) => x.version === v);
      if (!b) throw new HTTPException(404, { message: `確定版 第${v}版がありません` });
      return b;
    };
    const fromV = from ?? history[0]?.version;
    if (fromV === undefined) throw new HTTPException(400, { message: "確定版がまだありません" });
    const before = byVersion(fromV).snapshot;
    const after = to === undefined ? snapshotOf(await store.listRequirements(p.id)) : byVersion(to).snapshot;
    const d = diffSnapshots(before, after);
    const changed = new Set([...d.added, ...d.removed].map((x) => x.code).concat(d.modified.map((x) => x.code)));
    const cases = (await deps.testsOf(p)).cases;
    const plan = await store.latestTaskPlan(p.id);
    const screens = await store.latestScreens(p.id);
    return {
      from: fromV,
      to: to ?? "current",
      ...d,
      affected: {
        tests: cases.filter((c) => changed.has(c.requirementCode)).map((c) => c.id),
        stories: (plan?.plan.epics ?? []).flatMap((e) => e.stories).filter((s) => s.requirementCodes.some((c) => changed.has(c))).map((s) => ({ key: s.key, title: s.title })),
        screens: (screens?.model.screens ?? []).filter((s) => s.requirementCodes.some((c) => changed.has(c))).map((s) => ({ key: s.key, name: s.name })),
      },
    };
  }

  /* ---------- 仕様書 ---------- */

  async function specMore(p: Project) {
    const g = await glossary(p);
    const a = await acceptance(p);
    const reviews = await store.listReviews(p.id);
    const ap = await approval(p);
    const STATUS = { open: "承認待ち", approved: "承認", rejected: "差し戻し", withdrawn: "取り下げ" } as const;
    return [
      {
        title: "用語集",
        lines: g.variants.length ? [`表記ゆれ（用語集の言い換えを使っている要件）：${g.variants.map((v) => `${v.code}「${v.used}」→「${v.term}」`).join("、")}`] : [],
        tables: g.terms.length ? [{ head: ["用語", "意味", "言い換え（使わない）", "コード上の名前"], rows: g.terms.map((t) => [t.term, t.definition, t.synonyms.join("、"), t.codeName]) }] : [],
      },
      {
        title: "受け入れ基準",
        lines: [
          ...(a.defined ? [] : ["（まだ決めていません。以下は既定の基準です）"]),
          ...a.evaluation.items.map((i) => `${i.label}：${i.target}`),
        ],
      },
      {
        title: "レビューと承認",
        lines: [
          `確定に承認が${ap.required ? `必要（${p.settings?.requiredApprovals ?? 1}人）` : "不要"}／いまの状態：${{ approved: "承認済み", pending: "承認待ち", rejected: "差し戻し", stale: "承認後に要件が変更", none: "レビューなし" }[ap.status]}`,
          ...reviews.flatMap((r) => [
            `${r.code} ${r.createdAt.slice(0, 10)} ${r.requestedBy} が依頼（要件 ${r.snapshot.length}件）：${STATUS[r.status]}${r.note ? `　${r.note}` : ""}`,
            ...r.decisions.map((d) => `　${d.at.slice(0, 10)} ${d.by}：${d.decision === "approve" ? "承認" : "差し戻し"}${d.comment ? `（${d.comment}）` : ""}`),
          ]),
        ],
      },
    ];
  }

  /* ---------- ルート ---------- */

  function routes(app: Hono<any>) {
    app.get("/api/projects/:id/settings", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      return c.json({ approvalRequired: !!p.settings?.approvalRequired, requiredApprovals: p.settings?.requiredApprovals ?? 1 });
    });
    app.put("/api/projects/:id/settings", async (c) => {
      // 承認の要否は、編集者が自分で外せないよう管理者だけが変える
      const p = await ctx.loadProject(c, c.req.param("id"), "admin");
      const input = await ctx.body(c, SettingsInput);
      const u = await store.updateProjectSettings(p.id, input);
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "settings.update", targetType: "project", targetId: p.id, detail: { before: p.settings ?? {}, after: input } });
      return c.json(u?.settings ?? input);
    });

    app.get("/api/projects/:id/glossary", async (c) => c.json(await glossary(await ctx.loadProject(c, c.req.param("id"), "viewer"))));
    app.put("/api/projects/:id/glossary", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const { terms } = await ctx.body(c, GlossaryInput);
      const dup = terms.map((t) => t.term).filter((t, i, a) => a.indexOf(t) !== i);
      if (dup.length) throw new HTTPException(400, { message: `用語が重複しています: ${[...new Set(dup)].join("、")}` });
      await store.saveProjectSheet<GlossarySheet>(p.id, "glossary", { terms }, ctx.actorOf(c));
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "glossary.update", targetType: "project", targetId: p.id, detail: { terms: terms.length } });
      return c.json(await glossary(p));
    });
    app.post("/api/projects/:id/glossary/generate", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      return c.json(await generate(p, ctx.actorOf(c)), 201);
    });

    app.get("/api/projects/:id/acceptance", async (c) => c.json(await acceptance(await ctx.loadProject(c, c.req.param("id"), "viewer"))));
    app.put("/api/projects/:id/acceptance", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const { criteria } = await ctx.body(c, AcceptanceInput);
      const ids = criteria.custom.map((x) => x.id);
      if (new Set(ids).size !== ids.length) throw new HTTPException(400, { message: "受け入れ基準のIDが重複しています" });
      // 文を変えた条件は、確認をやり直す
      const prev = (await store.getProjectSheet<AcceptanceSheet>(p.id, "acceptance"))?.data;
      criteria.custom = criteria.custom.map((x) => {
        const old = prev?.custom.find((y) => y.id === x.id);
        return old && old.text === x.text ? { ...x, checked: old.checked, checkedBy: old.checkedBy, checkedAt: old.checkedAt } : { ...x, checked: false, checkedBy: null, checkedAt: null };
      });
      await store.saveProjectSheet<AcceptanceSheet>(p.id, "acceptance", criteria, ctx.actorOf(c));
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "acceptance.update", targetType: "project", targetId: p.id, detail: { criteria: { ...criteria, custom: criteria.custom.map((x) => x.text) } } });
      return c.json(await acceptance(p));
    });
    /** 業務の担当者が確かめる条件に印を付ける（レビュー担当以上） */
    app.post("/api/projects/:id/acceptance/check", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "reviewer");
      const input = await ctx.body(c, CheckInput);
      const sheet = await store.getProjectSheet<AcceptanceSheet>(p.id, "acceptance");
      if (!sheet) throw new HTTPException(400, { message: "受け入れ基準をまだ決めていません" });
      const item = sheet.data.custom.find((x) => x.id === input.id);
      if (!item) throw new HTTPException(404, { message: "受け入れ基準の条件が見つかりません" });
      Object.assign(item, input.checked ? { checked: true, checkedBy: ctx.actorOf(c), checkedAt: new Date().toISOString() } : { checked: false, checkedBy: null, checkedAt: null });
      await store.saveProjectSheet<AcceptanceSheet>(p.id, "acceptance", sheet.data, ctx.actorOf(c));
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "acceptance.update", targetType: "project", targetId: p.id, detail: { check: input } });
      return c.json(await acceptance(p));
    });

    app.get("/api/projects/:id/reviews", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      const fp = await currentFingerprint(p);
      const a = await approval(p);
      return c.json({ settings: { approvalRequired: a.required, requiredApprovals: p.settings?.requiredApprovals ?? 1 }, status: a.status, reviews: (await store.listReviews(p.id)).map((r) => reviewView(r, fp)) });
    });
    app.post("/api/projects/:id/reviews", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, ReviewInput);
      const reqs = await store.listRequirements(p.id);
      if (!reqs.length) throw new HTTPException(400, { message: "要件がまだありません" });
      // 前の依頼（承認待ち）は取り下げる
      for (const r of await store.listReviews(p.id)) if (r.status === "open") await store.updateReview(r.id, { status: "withdrawn", closedAt: new Date().toISOString() });
      const r = await store.addReview({ projectId: p.id, snapshot: snapshotOf(reqs), fingerprint: snapshotFingerprint(reqs), note: input.note, requiredApprovals: p.settings?.requiredApprovals ?? 1, requestedBy: ctx.actorOf(c) });
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "review.request", targetType: "project", targetId: p.id, detail: { code: r.code, requirements: reqs.length } });
      ctx.emit?.(p.orgId, "review.requested", { projectId: p.id, code: r.code, requirements: reqs.length, note: r.note });
      return c.json(reviewView(r, r.fingerprint), 201);
    });
    app.post("/api/reviews/:id/decide", async (c) => {
      const r = await store.getReview(c.req.param("id"));
      if (!r) throw new HTTPException(404, { message: "レビューが見つかりません" });
      const p = await ctx.loadProject(c, r.projectId, "reviewer");
      const input = await ctx.body(c, DecideInput);
      const actor = ctx.actorOf(c);
      if (r.status !== "open") throw new HTTPException(409, { message: "このレビューは終わっています" });
      if (r.requestedBy === actor) throw new HTTPException(403, { message: "依頼した人は承認できません（別の人が確認してください）" });
      if (r.decisions.some((d) => d.by === actor)) throw new HTTPException(409, { message: "すでに判断しています" });
      const fp = await currentFingerprint(p);
      if (input.decision === "approve" && r.fingerprint !== fp) throw new HTTPException(409, { message: "依頼した後に要件が変わりました。もう一度レビューを依頼してください" });
      if (input.decision === "reject" && !input.comment.trim()) throw new HTTPException(400, { message: "差し戻す理由を書いてください" });
      const decisions = [...r.decisions, { by: actor, decision: input.decision, comment: input.comment, at: new Date().toISOString() }];
      const approvals = decisions.filter((d) => d.decision === "approve").length;
      const status = input.decision === "reject" ? "rejected" : approvals >= r.requiredApprovals ? "approved" : "open";
      const u = await store.updateReview(r.id, { decisions, status, closedAt: status === "open" ? null : new Date().toISOString() });
      await audit(store, { orgId: p.orgId, actor, action: "review.decide", targetType: "project", targetId: p.id, detail: { code: r.code, decision: input.decision, status } });
      if (status !== "open") ctx.emit?.(p.orgId, "review.decided", { projectId: p.id, code: r.code, status, by: actor, comment: input.comment });
      return c.json(reviewView(u!, fp));
    });
    app.post("/api/reviews/:id/withdraw", async (c) => {
      const r = await store.getReview(c.req.param("id"));
      if (!r) throw new HTTPException(404, { message: "レビューが見つかりません" });
      const p = await ctx.loadProject(c, r.projectId, "editor");
      if (r.status !== "open") throw new HTTPException(409, { message: "このレビューは終わっています" });
      const u = await store.updateReview(r.id, { status: "withdrawn", closedAt: new Date().toISOString() });
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "review.withdraw", targetType: "project", targetId: p.id, detail: { code: r.code } });
      return c.json(reviewView(u!, await currentFingerprint(p)));
    });

    app.get("/api/projects/:id/baselines/diff", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      const num = (k: string) => {
        const v = c.req.query(k);
        if (!v || v === "current") return undefined;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new HTTPException(400, { message: `${k} は版の番号です` });
        return n;
      };
      return c.json(await diff(p, num("from"), num("to")));
    });
  }

  return { routes, glossary, acceptance, approval, approvalGate, diff, specMore };
}
