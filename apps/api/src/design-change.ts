/**
 * 画面設計（ワイヤーフレーム）と、要件定義の確定・変更管理の API。
 *
 * 画面（F6-5 / F6-6）
 * - 要件から画面一覧を作り、クリックで移動できるワイヤーフレームを返す
 * - 画面への意見は「要件に関わるもの」と「見た目の細部」に振り分ける。細部は設計工程への申し送りとして記録し、作り直しには使わない
 * - 作り直しが一定回数を超えたら、要件の確認に戻るよう促す
 *
 * 確定と変更管理（F5-5 / F5-6）
 * - 要件定義を確定すると、その時点の要件を確定版として残す。以後、要件の直接の編集・削除はできない
 * - 変更・追加・削除は変更要求として登録し、影響分析（トレース＋AI）の結果を見て
 *   「変更する／代替案で変更する／保留／変更しない」を選ぶ。変更すると確定版の版が上がる
 */
import {
  analyzeImpact,
  classifyScreenFeedback,
  designElementNames,
  generateScreens,
  renderPrototypeHtml,
  SCREEN_REVISION_NUDGE,
  SCREEN_TARGET_TYPES,
  screenFlowDiagram,
  summarizeScreens,
  summarizeUmlModel,
  type ChangeProposal,
  type Diagram,
  type ImpactContext,
  BusinessRule,
  Ears,
  EARS_TYPES,
  renderEars,
} from "@arn/ai-core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import { changedSince, latestItems, type AnyContext, type ImplementationContext } from "./implementation.js";
import type { Baseline, ChangeRequest, JobProgress, Project, Requirement, ScreenRecord } from "./store.js";
import { usageOf } from "./store.js";

const ScreenGenerateInput = z.object({
  /** 未反映の意見（要件に関わるもの）を作り直しに使うか */
  applyFeedback: z.boolean().default(true),
});
const FeedbackInput = z.object({
  screenKey: z.string().max(10).nullable().default(null),
  text: z.string().min(1).max(1000),
});
const BaselineInput = z.object({
  reason: z.string().max(1000).default(""),
  /** 非機能要件の検討が終わっていなくても確定する（reason が必要） */
  force: z.boolean().default(false),
});

/** 確定前の確認（非機能要件シート） */
export type BaselineGate = (p: Project) => Promise<{ ok: boolean; undecided: string[]; errors: string[]; coverage: number }>;
const TypeSchema = z.enum(["BR", "AC", "FR", "RL", "NFR", "CN"]);
const PrioritySchema = z.enum(["must", "should", "could"]);
const ChangeInput = z.object({
  kind: z.enum(["modify", "add", "delete"]),
  requirementId: z.string().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  priority: PrioritySchema.optional(),
  type: TypeSchema.optional(),
  /** 機能要件・非機能要件の EARS の構造（あれば内容はここから組み立てる） */
  ears: Ears.optional(),
  /** 業務ルール（RL）の種類と具体例 */
  rule: BusinessRule.optional(),
  reason: z.string().max(2000).default(""),
});
const DecideInput = z.object({
  option: z.enum(["apply", "alternative", "defer", "reject"]),
  reason: z.string().max(2000).default(""),
  /** alternative のとき、どの代替案を使うか */
  alternativeIndex: z.number().int().min(0).default(0),
});

const TYPE_PHASE: Record<string, string> = { BR: "purpose", AC: "actors", FR: "functions", RL: "rules", NFR: "quality", CN: "constraints" };
const snapshotOf = (rs: Requirement[]): Baseline["snapshot"] =>
  rs.map((r) => ({ code: r.code, type: r.type, title: r.title, description: r.description, priority: r.priority, version: r.version }));

/** 確定前の確認（レビューと承認） */
export type ApprovalGate = (p: Project) => Promise<{ ok: boolean; required: boolean; status: string; review: { code: string } | null }>;

export function designAndChange(ctx: ImplementationContext, opts: { gate?: BaselineGate; approvalGate?: ApprovalGate } = {}) {
  const { store } = ctx;

  /** 確定済みなら確定版を返す */
  const baselineOf = (projectId: string) => store.latestBaseline(projectId);

  /* ------------------------------------------------------------------ */
  /* 画面                                                                */
  /* ------------------------------------------------------------------ */

  const screenReqs = (rs: Requirement[]) => rs.map((r) => ({ code: r.code, type: r.type, title: r.title }));

  const screensView = async (p: Project, rec: ScreenRecord | null) => {
    const current = await store.listRequirements(p.id);
    const feedback = await store.listScreenFeedback(p.id);
    const labels = await ctx.labelsOf(p.orgId);
    const changed = rec ? changedSince(rec, current) : [];
    return {
      screens: rec
        ? {
            id: rec.id,
            model: rec.model,
            revision: rec.revision,
            provider: labels.get(rec.providerId) ?? rec.providerId,
            createdAt: rec.createdAt,
            stale: changed.length > 0,
            changed,
          }
        : null,
      /** 次の作り直しで反映する意見 */
      open: feedback.filter((f) => f.status === "open"),
      applied: feedback.filter((f) => f.status === "applied"),
      /** 設計工程への申し送り（見た目の細部） */
      notes: feedback.filter((f) => f.level !== "requirement"),
      nudge:
        rec && rec.revision >= SCREEN_REVISION_NUDGE
          ? `画面を${rec.revision}回作り直しています。見た目の細部は設計工程で決めるため、ここでは「必要な情報と操作がそろっているか」「画面のつながり」の確認に絞り、足りない点は要件として確定してください。`
          : null,
    };
  };

  async function executeScreens(p: Project, input: z.infer<typeof ScreenGenerateInput>, actor: string, report?: (pr: JobProgress) => Promise<void>) {
    const current = await store.listRequirements(p.id);
    if (!current.some((r) => SCREEN_TARGET_TYPES.includes(r.type))) {
      throw new HTTPException(400, { message: "機能要件がまだありません。ヒアリングで機能要件を確定してから画面を作成してください" });
    }
    const ids = [...new Set([...p.aiConfig.generatorIds, ...(p.aiConfig.evaluatorId ? [p.aiConfig.evaluatorId] : [])])];
    const b = await ctx.budget(p.orgId, ids);
    const usable = ids.filter((id) => !b.excluded.has(id));
    if (!usable.length) throw new HTTPException(429, { message: `使えるAIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const providers = await ctx.providersOf(p.orgId, usable);
    if (p.confidential && providers.some((x) => !x.isLocal)) throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    const labels = await ctx.labelsOf(p.orgId);
    const step = (status: "running" | "done" | "failed", reason?: string) =>
      report?.({ steps: [{ key: `generator:${usable[0]}`, label: `画面設計: ${labels.get(usable[0]!) ?? usable[0]}`, status, reason }] });
    await step("running");

    const open = input.applyFeedback ? (await store.listScreenFeedback(p.id)).filter((f) => f.status === "open") : [];
    const uml = await store.latestUmlModel(p.id);
    const prev = await store.latestScreens(p.id);
    let result: Awaited<ReturnType<typeof generateScreens>>;
    try {
      result = await generateScreens(providers, p.name, p.purpose, screenReqs(current), {
        design: uml ? summarizeUmlModel(uml.model) : "",
        // 見た目の細部の指摘は渡さない（要件に関わる部分だけ）
        feedback: open.map((f) => `${f.screenKey ? `${f.screenKey}: ` : ""}${f.text}`),
        timeoutMs: ctx.timeoutMs,
      });
    } catch (e) {
      await step("failed", (e as Error).message);
      throw new HTTPException(502, { message: (e as Error).message });
    }
    await step("done");
    await store.addUsage({ orgId: p.orgId, providerId: result.providerId, projectId: p.id, ...usageOf(result.usage) });
    const rec = await store.saveScreens({
      projectId: p.id,
      model: result.model,
      providerId: result.providerId,
      basis: current.map((r) => ({ code: r.code, version: r.version })),
      revision: (prev?.revision ?? 0) + 1,
      createdBy: actor,
    });
    await store.setScreenFeedbackStatus(
      open.map((f) => f.id),
      "applied",
    );
    await audit(store, {
      orgId: p.orgId,
      actor,
      action: "ai.screens",
      targetType: "screens",
      targetId: rec.id,
      detail: {
        projectId: p.id,
        revision: rec.revision,
        sent: { requirements: current.length, design: Boolean(uml), feedback: open.length },
        generators: [{ id: result.providerId, label: labels.get(result.providerId), tokens: usageOf(result.usage) }],
        failures: result.failures.map((f) => ({ id: f.providerId, label: labels.get(f.providerId), reason: f.reason })),
        uncovered: result.model.uncovered,
      },
    });
    const warnings = [...b.warnings];
    if (result.model.uncovered.length) warnings.push(`次の機能要件に対応する画面がありません: ${result.model.uncovered.join(", ")}`);
    return { ...(await screensView(p, rec)), warnings, failures: result.failures.map((f) => ({ provider: labels.get(f.providerId) ?? f.providerId, reason: f.reason })) };
  }

  /* ------------------------------------------------------------------ */
  /* 影響分析                                                            */
  /* ------------------------------------------------------------------ */

  const proposalOf = async (cr: ChangeRequest): Promise<ChangeProposal> => {
    const r = cr.requirementId ? await store.getRequirement(cr.requirementId) : null;
    return {
      kind: cr.kind,
      code: cr.requirementCode,
      before: r ? { title: r.title, description: r.description, priority: r.priority } : null,
      after: cr.proposal,
      reason: cr.reason,
    };
  };

  const impactContext = async (p: Project): Promise<ImpactContext> => {
    const current = await store.listRequirements(p.id);
    const plan = await store.latestTaskPlan(p.id);
    const items = plan ? [...latestItems(await store.listTaskExports(plan.id)).values()] : [];
    const integrations = new Map((await store.listIntegrations(p.orgId)).map((i) => [i.id, i.label]));
    const screens = await store.latestScreens(p.id);
    const uml = await store.latestUmlModel(p.id);
    return {
      projectName: p.name,
      requirements: current.map((r) => ({ code: r.code, type: r.type, title: r.title, priority: r.priority })),
      stories: (plan?.plan.epics ?? []).flatMap((e) =>
        e.stories.map((s) => ({
          key: s.key,
          title: s.title,
          requirementCodes: s.requirementCodes,
          estimate: s.estimate,
          links: items
            .filter((x) => x.key === s.key && x.url)
            .map((x) => ({ url: x.url, externalKey: x.externalKey, integration: integrations.get(x.integrationId) ?? x.target })),
        })),
      ),
      screens: (screens?.model.screens ?? []).map((s) => ({ key: s.key, name: s.name, requirementCodes: s.requirementCodes })),
      design: uml ? summarizeUmlModel(uml.model) : "",
      designElements: uml ? designElementNames(uml.model) : [],
    };
  };

  async function executeImpact(cr: ChangeRequest, actor: string, report?: (pr: JobProgress) => Promise<void>) {
    const p = (await store.getProject(cr.projectId))!;
    if (cr.status === "approved" || cr.status === "rejected") throw new HTTPException(409, { message: "この変更要求は判断済みです" });
    // 複数AIモードでは生成AIすべてで分析する（評価AIは使わない）。単一AIモードでは1つ
    const ids = p.aiConfig.mode === "multi" ? p.aiConfig.generatorIds : p.aiConfig.generatorIds.slice(0, 1);
    const b = await ctx.budget(p.orgId, ids);
    const usable = ids.filter((id) => !b.excluded.has(id));
    const providers = usable.length ? await ctx.providersOf(p.orgId, usable) : [];
    if (p.confidential && providers.some((x) => !x.isLocal)) throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    const labels = await ctx.labelsOf(p.orgId);
    const steps: NonNullable<JobProgress["steps"]> = usable.map((id) => ({ key: `generator:${id}`, label: `影響分析: ${labels.get(id) ?? id}`, status: "waiting" }));
    let chain = Promise.resolve();
    const push = () => {
      const snap = { steps: steps.map((s) => ({ ...s })) };
      chain = chain.then(() => report?.(snap)).catch(() => undefined);
    };
    push();
    const { report: impact, usages } = await analyzeImpact(providers, await proposalOf(cr), await impactContext(p), {
      timeoutMs: ctx.timeoutMs,
      onProgress: (id, status, reason) => {
        const s = steps.find((x) => x.key === `generator:${id}`);
        if (!s) return;
        s.status = status;
        if (reason) s.reason = reason;
        push();
      },
    });
    await chain;
    for (const u of usages) await store.addUsage({ orgId: p.orgId, providerId: u.providerId, projectId: p.id, ...usageOf(u.usage) });
    // AIの名前は画面に出す（案の比較ではないので匿名にしない）
    const named = {
      ...impact,
      summaries: impact.summaries.map((s) => ({ ...s, provider: labels.get(s.providerId) ?? s.providerId })),
      failures: impact.failures.map((f) => ({ ...f, provider: labels.get(f.providerId) ?? f.providerId })),
      alternatives: impact.alternatives.map((a) => ({ ...a, provider: labels.get(a.providerId) ?? a.providerId })),
      warnings: [...b.warnings, ...(usable.length ? [] : ["使えるAIがないため、トレースによる機械的な分析のみです。"])],
      analyzedAt: new Date().toISOString(),
    };
    const updated = await store.updateChangeRequest(cr.id, { impact: named, status: cr.status === "deferred" ? "deferred" : "analyzed" });
    await audit(store, {
      orgId: p.orgId,
      actor,
      action: "ai.impact",
      targetType: "change_request",
      targetId: cr.id,
      detail: {
        projectId: p.id,
        code: cr.code,
        analysts: usages.map((u) => ({ id: u.providerId, label: labels.get(u.providerId), tokens: usageOf(u.usage) })),
        failures: named.failures.map((f) => ({ id: f.providerId, label: f.provider, reason: f.reason })),
        scale: impact.scale,
        effort: impact.effort,
      },
    });
    return updated!;
  }

  /* ------------------------------------------------------------------ */
  /* ルート                                                              */
  /* ------------------------------------------------------------------ */

  const loadChange = async (c: AnyContext, id: string, role: "viewer" | "editor") => {
    const cr = await store.getChangeRequest(id);
    if (!cr) throw new HTTPException(404, { message: "変更要求が見つかりません" });
    const p = await ctx.loadProject(c, cr.projectId, role);
    return { cr, p };
  };

  function routes(
    app: Hono<any>,
    jobs: {
      wantsAsync: (c: Context) => boolean;
      enqueue: (c: AnyContext, p: Project, kind: "screens" | "impact", input: Record<string, unknown>) => Promise<Response>;
    },
  ) {
    /* ---------- 画面 ---------- */
    app.get("/api/projects/:id/screens", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      return c.json(await screensView(p, await store.latestScreens(p.id)));
    });

    app.post("/api/projects/:id/screens/generate", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, ScreenGenerateInput);
      if (jobs.wantsAsync(c)) {
        if (!(await store.listRequirements(p.id)).some((r) => SCREEN_TARGET_TYPES.includes(r.type))) {
          throw new HTTPException(400, { message: "機能要件がまだありません。ヒアリングで機能要件を確定してから画面を作成してください" });
        }
        await ctx.budget(p.orgId, []);
        return jobs.enqueue(c, p, "screens", input);
      }
      return c.json(await executeScreens(p, input, ctx.actorOf(c)), 201);
    });

    /** クリックで画面を移動できるワイヤーフレーム（スクリプトなしのHTML） */
    app.get("/api/projects/:id/screens/prototype.html", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      const rec = await store.latestScreens(p.id);
      if (!rec) throw new HTTPException(404, { message: "画面がまだありません" });
      const html = renderPrototypeHtml(rec.model, p.name, screenReqs(await store.listRequirements(p.id)));
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
      };
      if (c.req.query("download")) {
        headers["content-disposition"] = `attachment; filename="prototype.html"; filename*=UTF-8''${encodeURIComponent(`${p.name}_画面イメージ.html`)}`;
      }
      return c.body(html, 200, headers);
    });

    /** 画面への意見。見た目の細部は申し送りとして記録し、要件に関わるものは次の作り直しに反映する */
    app.post("/api/projects/:id/screens/feedback", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, FeedbackInput);
      const rec = await store.latestScreens(p.id);
      if (!rec) throw new HTTPException(400, { message: "画面がまだありません" });
      if (input.screenKey && !rec.model.screens.some((s) => s.key === input.screenKey)) {
        throw new HTTPException(400, { message: `画面がありません: ${input.screenKey}` });
      }
      const cls = classifyScreenFeedback(input.text);
      const fb = await store.addScreenFeedback({
        projectId: p.id,
        screenKey: input.screenKey,
        text: input.text,
        level: cls.level,
        detailHits: cls.detailHits,
        requirementHits: cls.requirementHits,
        status: cls.level === "detail" ? "noted" : "open",
        revision: rec.revision,
        createdBy: ctx.actorOf(c),
      });
      await audit(store, {
        orgId: p.orgId,
        actor: ctx.actorOf(c),
        action: "screen.feedback",
        targetType: "screens",
        targetId: rec.id,
        detail: { projectId: p.id, screenKey: input.screenKey, level: cls.level, text: input.text.slice(0, 200) },
      });
      const view = await screensView(p, rec);
      return c.json({ feedback: fb, guidance: cls.guidance, nudge: view.nudge }, 201);
    });

    /* ---------- 確定 ---------- */
    app.get("/api/projects/:id/baseline", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      const history = await store.listBaselines(p.id);
      const changes = await store.listChangeRequests(p.id);
      return c.json({
        current: history[0] ?? null,
        history: history.map((b) => ({ version: b.version, reason: b.reason, createdBy: b.createdBy, createdAt: b.createdAt, requirements: b.snapshot.length })),
        pending: changes.filter((x) => x.status === "open" || x.status === "analyzed").length,
        deferred: changes.filter((x) => x.status === "deferred").length,
      });
    });

    /** 要件定義を確定する（以後の変更は変更要求で行う） */
    app.post("/api/projects/:id/baseline", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, BaselineInput);
      if (await baselineOf(p.id)) throw new HTTPException(409, { message: "要件定義は確定済みです。変更は変更要求で行ってください" });
      const reqs = await store.listRequirements(p.id);
      if (!reqs.length) throw new HTTPException(400, { message: "要件がまだありません" });
      // 承認が必要なプロジェクトでは、いまの要件の内容で承認されていること（理由を書いても飛ばせない）
      const ap = opts.approvalGate ? await opts.approvalGate(p) : null;
      if (ap && !ap.ok) {
        const why = { pending: "承認を待っています", rejected: "差し戻されています", stale: "承認した後に要件が変わりました", none: "レビューを依頼していません" }[ap.status] ?? ap.status;
        return c.json({ error: `このプロジェクトは確定に承認が必要です（${why}）。「変更管理」でレビューを依頼し、承認を受けてください`, code: "approval_required", status: ap.status }, 409);
      }
      // 非機能要件の検討が終わっているか（未検討の項目・要対応の矛盾）
      const g = opts.gate ? await opts.gate(p) : null;
      if (g && !g.ok) {
        if (!input.force) {
          return c.json(
            {
              error: `非機能要件の検討が終わっていません（未検討 ${g.undecided.length}項目、要対応 ${g.errors.length}件）。「非機能要件」で検討するか、理由を書いて確定してください`,
              code: "nfr_incomplete",
              undecided: g.undecided,
              errors: g.errors,
              coverage: g.coverage,
            },
            409,
          );
        }
        if (!input.reason.trim()) throw new HTTPException(400, { message: "非機能要件の検討を残したまま確定する理由を書いてください" });
      }
      const b = await store.addBaseline({ projectId: p.id, snapshot: snapshotOf(reqs), reason: input.reason || "要件定義の確定", createdBy: ctx.actorOf(c) });
      await audit(store, {
        orgId: p.orgId,
        actor: ctx.actorOf(c),
        action: "baseline.create",
        targetType: "project",
        targetId: p.id,
        detail: {
          version: b.version,
          requirements: reqs.length,
          reason: b.reason,
          nfr: g ? { coverage: g.coverage, undecided: g.undecided.length, errors: g.errors.length, override: !g.ok } : null,
          approval: ap ? { required: ap.required, status: ap.status, review: ap.review?.code ?? null } : null,
        },
      });
      ctx.emit?.(p.orgId, "baseline.created", { projectId: p.id, version: b.version, reason: b.reason, requirements: reqs.length });
      return c.json(b, 201);
    });

    /* ---------- 変更要求 ---------- */
    app.get("/api/projects/:id/changes", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      return c.json(await store.listChangeRequests(p.id));
    });

    app.post("/api/projects/:id/changes", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, ChangeInput);
      if (!(await baselineOf(p.id))) {
        throw new HTTPException(400, { message: "要件定義はまだ確定していません。確定前は要件一覧で直接編集できます" });
      }
      let target: Requirement | null = null;
      if (input.kind !== "add") {
        target = input.requirementId ? await store.getRequirement(input.requirementId) : null;
        if (!target || target.deletedAt || target.projectId !== p.id) throw new HTTPException(400, { message: "変更する要件を選んでください" });
      }
      let proposal: ChangeRequest["proposal"] = null;
      const earsOk = (type: string) => input.ears && EARS_TYPES.includes(type);
      if (input.kind === "modify") {
        proposal = {
          title: earsOk(target!.type) ? renderEars(input.ears!) : (input.title ?? target!.title),
          ...(earsOk(target!.type) ? { ears: input.ears } : {}),
          ...(target!.type === "RL" && input.rule ? { rule: input.rule } : {}),
          description: input.description ?? target!.description,
          priority: input.priority ?? target!.priority,
          type: target!.type,
        };
        const ruleChanged = !!proposal.rule && JSON.stringify(proposal.rule) !== JSON.stringify(target!.rule ?? null);
        if (!ruleChanged && proposal.title === target!.title && proposal.description === target!.description && proposal.priority === target!.priority) {
          throw new HTTPException(400, { message: "変更する内容がありません" });
        }
      } else if (input.kind === "add") {
        const title = input.type && earsOk(input.type) ? renderEars(input.ears!) : input.title;
        if (!title || !input.type) throw new HTTPException(400, { message: "追加する要件の内容と区分を入力してください" });
        proposal = {
          title,
          description: input.description ?? "",
          priority: input.priority ?? "should",
          type: input.type,
          ...(earsOk(input.type) ? { ears: input.ears } : {}),
          ...(input.type === "RL" && input.rule ? { rule: input.rule } : {}),
        };
      }
      const cr = await store.addChangeRequest({
        projectId: p.id,
        kind: input.kind,
        requirementId: target?.id ?? null,
        requirementCode: target?.code ?? null,
        proposal,
        reason: input.reason,
        source: "manual",
        createdBy: ctx.actorOf(c),
      });
      await audit(store, {
        orgId: p.orgId,
        actor: ctx.actorOf(c),
        action: "change.create",
        targetType: "change_request",
        targetId: cr.id,
        detail: { projectId: p.id, code: cr.code, kind: cr.kind, requirement: cr.requirementCode, proposal, reason: cr.reason },
      });
      return c.json(cr, 201);
    });

    app.get("/api/changes/:id", async (c) => {
      const { cr } = await loadChange(c, c.req.param("id"), "viewer");
      return c.json(cr);
    });

    /** 影響分析（トレース＋AI）。保留中のものは分析し直せる */
    app.post("/api/changes/:id/analyze", async (c) => {
      const { cr, p } = await loadChange(c, c.req.param("id"), "editor");
      if (cr.status === "approved" || cr.status === "rejected") throw new HTTPException(409, { message: "この変更要求は判断済みです" });
      if (jobs.wantsAsync(c)) {
        await ctx.budget(p.orgId, []);
        return jobs.enqueue(c, p, "impact", { changeId: cr.id });
      }
      return c.json(await executeImpact(cr, ctx.actorOf(c)), 201);
    });

    /** 選択肢から判断する */
    app.post("/api/changes/:id/decide", async (c) => {
      const { cr, p } = await loadChange(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, DecideInput);
      if (cr.status === "approved" || cr.status === "rejected") throw new HTTPException(409, { message: "この変更要求は判断済みです" });
      if (!cr.impact && (input.option === "apply" || input.option === "alternative")) {
        throw new HTTPException(400, { message: "影響分析をしてから判断してください" });
      }
      const actor = ctx.actorOf(c);
      const decision: NonNullable<ChangeRequest["decision"]> = { option: input.option, reason: input.reason, by: actor, at: new Date().toISOString() };
      let status: ChangeRequest["status"] = input.option === "defer" ? "deferred" : input.option === "reject" ? "rejected" : "approved";

      if (input.option === "apply" || input.option === "alternative") {
        let after = cr.proposal;
        if (input.option === "alternative") {
          if (cr.kind === "delete") throw new HTTPException(400, { message: "削除の変更要求には代替案を使えません" });
          const alt = cr.impact!.alternatives[input.alternativeIndex];
          if (!alt) throw new HTTPException(400, { message: "代替案がありません" });
          after = { ...cr.proposal!, title: alt.title, description: alt.description, ears: null };
        }
        const label = `変更要求 ${cr.code}`;
        if (cr.kind === "add") {
          const [added] = await store.addRequirements(p.id, [
            {
              title: after!.title,
              description: after!.description,
              type: after!.type,
              priority: after!.priority,
              ears: after!.ears ?? undefined,
              rule: after!.rule ?? undefined,
              roundId: null,
              source: label,
              phaseKey: TYPE_PHASE[after!.type] ?? null,
            },
          ]);
          decision.requirementCode = added!.code;
        } else {
          const r = cr.requirementId ? await store.getRequirement(cr.requirementId) : null;
          if (!r || r.deletedAt) throw new HTTPException(409, { message: "対象の要件はすでに削除されています" });
          if (cr.kind === "modify") {
            // EARS の構造がなく文を変えた場合は、古い構造を残さない
            const ears = after!.ears !== undefined && after!.ears !== null ? after!.ears : after!.title !== r.title ? null : undefined;
            await store.updateRequirement(r.id, { title: after!.title, description: after!.description, priority: after!.priority, ears, ...(after!.rule ? { rule: after!.rule } : {}) }, actor, `${label}: ${cr.reason || input.reason}`);
          } else {
            await store.deleteRequirement(r.id);
          }
          decision.requirementCode = r.code;
        }
        const b = await store.addBaseline({
          projectId: p.id,
          snapshot: snapshotOf(await store.listRequirements(p.id)),
          reason: `${cr.code} ${input.option === "alternative" ? "（代替案）" : ""}${input.reason || cr.reason}`.trim(),
          createdBy: actor,
        });
        decision.baselineVersion = b.version;
        status = "approved";
      }
      const updated = await store.updateChangeRequest(cr.id, { status, decision });
      await audit(store, {
        orgId: p.orgId,
        actor,
        action: "change.decide",
        targetType: "change_request",
        targetId: cr.id,
        detail: { projectId: p.id, code: cr.code, option: input.option, reason: input.reason, requirement: decision.requirementCode, baselineVersion: decision.baselineVersion },
      });
      ctx.emit?.(p.orgId, "change.decided", { projectId: p.id, code: cr.code, option: input.option, status, requirementCode: decision.requirementCode ?? null, baselineVersion: decision.baselineVersion ?? null });
      const i = cr.impact;
      return c.json({
        change: updated,
        // 変更した場合に見直しが必要なもの
        followUps:
          status === "approved" && i
            ? { design: i.design, screens: i.screens, stories: i.stories, issues: i.issues }
            : null,
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 仕様書・UMLへの反映                                                  */
  /* ------------------------------------------------------------------ */

  async function specMore(p: Project): Promise<{ baseline?: string; extras: Array<{ title: string; lines: string[] }>; diagrams: Diagram[] }> {
    const [b, rec, feedback, changes] = await Promise.all([baselineOf(p.id), store.latestScreens(p.id), store.listScreenFeedback(p.id), store.listChangeRequests(p.id)]);
    const KIND = { modify: "変更", add: "追加", delete: "削除" } as const;
    const OPTION = { apply: "変更", alternative: "代替案で変更", defer: "保留", reject: "変更しない" } as const;
    return {
      baseline: b ? `確定版 v${b.version}（${b.createdAt.slice(0, 10)}）` : "未確定（作成中）",
      diagrams: rec ? [screenFlowDiagram(rec.model)] : [],
      extras: [
        { title: "8. 画面一覧（ワイヤーフレーム）", lines: rec ? summarizeScreens(rec.model).split("\n").map((l) => l.replace(/^- /, "")) : [] },
        {
          title: "9. 設計工程への申し送り（画面の見た目など）",
          lines: feedback.filter((f) => f.level !== "requirement").map((f) => `${f.screenKey ?? "全体"}：${f.text}`),
        },
        {
          title: "10. 変更履歴",
          lines: [...changes]
            .reverse()
            .map(
              (x) =>
                `${x.code} ${KIND[x.kind]}${x.requirementCode ? ` ${x.requirementCode}` : ""}${x.proposal ? `「${x.proposal.title}」` : ""}：${
                  x.decision ? `${OPTION[x.decision.option]}${x.decision.baselineVersion ? `（確定版 v${x.decision.baselineVersion}）` : ""}${x.decision.reason ? ` ${x.decision.reason}` : ""}` : "判断待ち"
                }${x.reason ? `／理由：${x.reason}` : ""}`,
            ),
        },
      ],
    };
  }

  return {
    routes,
    specMore,
    baselineOf,
    jobHandlers: {
      screens: (p: Project, input: unknown, actor: string, report: (pr: JobProgress) => Promise<void>) =>
        executeScreens(p, ctx.parseOrThrow(ScreenGenerateInput, input), actor, report),
      impact: async (input: unknown, actor: string, report: (pr: JobProgress) => Promise<void>) => {
        const { changeId } = ctx.parseOrThrow(z.object({ changeId: z.string() }), input);
        const cr = await store.getChangeRequest(changeId);
        if (!cr) throw new HTTPException(404, { message: "変更要求が見つかりません" });
        return executeImpact(cr, actor, report);
      },
    },
  };
}
