/**
 * 非機能要件シートの API（機能 F5-8）。
 * - システムの性格（4つの質問）から推奨水準を示し、26項目それぞれを「決定／対象外／保留」にする
 * - 複数AIの推奨水準を並べ、意見が分かれた項目を示す。一致した提案はまとめて採用できる
 * - 決めた水準から EARS の非機能要件を作る（確定後は変更要求にする）
 * - 要件定義の確定時に、未検討の項目と矛盾（エラー）が残っていないかを確かめる
 */
import {
  evaluateNfr,
  GRADE_LABELS,
  gradesOf,
  NFR_CATEGORIES,
  NFR_ITEM_BY_KEY,
  NFR_ITEMS,
  nfrRequirement,
  nfrSheetLines,
  PROFILE_QUESTIONS,
  recommendedLevel,
  suggestNfr,
  type NfrDecision,
  type NfrProfile,
} from "@arn/ai-core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import type { AnyContext, ImplementationContext } from "./implementation.js";
import type { JobProgress, NfrSheet, Project } from "./store.js";
import { usageOf } from "./store.js";

const choice = z.union([z.literal(0), z.literal(1), z.literal(2)]).optional();
const ProfileInput = z.object({ users: choice, impact: choice, data: choice, hours: choice }).strict();
const ItemInput = z
  .object({
    status: z.enum(["undecided", "decided", "na", "deferred"]),
    level: z.string().nullable().optional(),
    value: z.string().max(200).optional(),
    rationale: z.string().max(1000).optional(),
    owner: z.string().max(100).optional(),
  })
  .strict();
const SuggestInput = z.object({ onlyUndecided: z.boolean().default(true) });
const ApplyInput = z.object({ keys: z.array(z.string()).optional() });
const RequirementsInput = z.object({ systemName: z.string().min(1).max(60).default("本システム") });

const empty = (): NfrDecision => ({ status: "undecided", level: null, value: "", rationale: "", owner: "" });

export function nfrSheet(ctx: ImplementationContext) {
  const { store } = ctx;
  const load = async (projectId: string): Promise<Omit<NfrSheet, "updatedAt"> & { updatedAt: string | null }> =>
    (await store.getNfrSheet(projectId)) ?? { projectId, profile: {}, decisions: {}, suggestions: null, updatedAt: null };

  const view = async (p: Project) => {
    const s = await load(p.id);
    const g = gradesOf(s.profile);
    const ev = evaluateNfr(s.profile, s.decisions);
    const reqs = new Map((await store.listRequirements(p.id)).map((r) => [r.id, r]));
    const sug = new Map((s.suggestions?.items ?? []).map((x) => [x.key, x]));
    return {
      profile: s.profile,
      profileQuestions: PROFILE_QUESTIONS,
      profileAnswered: Object.keys(s.profile).length,
      grade: { overall: g.overall, label: GRADE_LABELS[g.overall], byCategory: g },
      categories: NFR_CATEGORIES,
      items: NFR_ITEMS.map((i) => {
        const d = s.decisions[i.key] ?? empty();
        const r = d.requirementId ? reqs.get(d.requirementId) : undefined;
        return {
          key: i.key,
          category: i.category,
          name: i.name,
          question: i.question,
          why: i.why,
          organizational: Boolean(i.organizational),
          levels: i.levels.map((l) => ({ id: l.id, label: l.label, cost: l.cost, makesRequirement: !i.organizational && l.ears !== null && (l.ears !== undefined || Boolean(i.template)) })),
          recommended: recommendedLevel(i, s.profile).id,
          decision: d,
          requirement: r && !r.deletedAt ? { id: r.id, code: r.code, title: r.title } : null,
          suggestion: sug.get(i.key) ?? null,
        };
      }),
      evaluation: ev,
      suggestionsAt: s.suggestions?.at ?? null,
      suggestionFailures: s.suggestions?.failures ?? [],
      updatedAt: s.updatedAt,
    };
  };

  /** 要件定義の確定前の確認。未検討の項目とエラーの矛盾があれば ok: false */
  async function gate(p: Project) {
    const s = await load(p.id);
    const ev = evaluateNfr(s.profile, s.decisions);
    const undecided = NFR_ITEMS.filter((i) => (s.decisions[i.key]?.status ?? "undecided") === "undecided").map((i) => i.name);
    const errors = ev.findings.filter((f) => f.severity === "error").map((f) => f.message);
    return { ok: undecided.length === 0 && errors.length === 0, undecided, errors, coverage: ev.coverage };
  }

  async function executeSuggest(p: Project, input: z.infer<typeof SuggestInput>, actor: string, report?: (pr: JobProgress) => Promise<void>) {
    const s = await load(p.id);
    const keys = input.onlyUndecided ? NFR_ITEMS.filter((i) => (s.decisions[i.key]?.status ?? "undecided") === "undecided").map((i) => i.key) : undefined;
    if (keys && !keys.length) throw new HTTPException(400, { message: "未検討の項目はありません" });
    const ids = p.aiConfig.mode === "multi" ? p.aiConfig.generatorIds : p.aiConfig.generatorIds.slice(0, 1);
    const b = await ctx.budget(p.orgId, ids);
    const usable = ids.filter((id) => !b.excluded.has(id));
    if (!usable.length) throw new HTTPException(429, { message: `使えるAIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const providers = await ctx.providersOf(p.orgId, usable);
    if (p.confidential && providers.some((x) => !x.isLocal)) throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    const labels = await ctx.labelsOf(p.orgId);
    const steps: NonNullable<JobProgress["steps"]> = usable.map((id) => ({ key: `generator:${id}`, label: `非機能要件の提案: ${labels.get(id) ?? id}`, status: "waiting" }));
    let chain = Promise.resolve();
    const push = () => {
      const snap = { steps: steps.map((x) => ({ ...x })) };
      chain = chain.then(() => report?.(snap)).catch(() => undefined);
    };
    push();
    let r: Awaited<ReturnType<typeof suggestNfr>>;
    try {
      r = await suggestNfr(
        providers,
        { projectName: p.name, purpose: p.purpose, profile: s.profile, requirements: (await store.listRequirements(p.id)).map((x) => ({ code: x.code, type: x.type, title: x.title })), keys },
        {
          timeoutMs: ctx.timeoutMs,
          onProgress: (id, status, reason) => {
            const st = steps.find((x) => x.key === `generator:${id}`);
            if (!st) return;
            st.status = status;
            if (reason) st.reason = reason;
            push();
          },
        },
      );
    } catch (e) {
      await chain;
      throw new HTTPException(502, { message: (e as Error).message });
    }
    await chain;
    for (const u of r.usages) await store.addUsage({ orgId: p.orgId, providerId: u.providerId, projectId: p.id, ...usageOf(u.usage) });
    // 未検討以外の項目の古い提案は残す
    const keep = (s.suggestions?.items ?? []).filter((x) => !r.suggestions.some((y) => y.key === x.key));
    const items = [
      ...keep,
      ...r.suggestions.map((x) => ({ ...x, proposals: x.proposals.map((pr) => ({ ...pr, provider: labels.get(pr.providerId) ?? pr.providerId })) })),
    ];
    await store.saveNfrSheet({
      projectId: p.id,
      profile: s.profile,
      decisions: s.decisions,
      suggestions: { items, at: new Date().toISOString(), failures: r.failures.map((f) => ({ provider: labels.get(f.providerId) ?? f.providerId, reason: f.reason })) },
    });
    await audit(store, {
      orgId: p.orgId,
      actor,
      action: "ai.nfr",
      targetType: "project",
      targetId: p.id,
      detail: {
        items: r.suggestions.length,
        split: r.suggestions.filter((x) => x.split).map((x) => x.key),
        generators: r.usages.map((u) => ({ id: u.providerId, label: labels.get(u.providerId), tokens: usageOf(u.usage) })),
        failures: r.failures.map((f) => ({ id: f.providerId, label: labels.get(f.providerId), reason: f.reason })),
      },
    });
    return view(p);
  }

  function routes(
    app: Hono<any>,
    jobs: { wantsAsync: (c: Context) => boolean; enqueue: (c: AnyContext, p: Project, kind: "nfr", input: Record<string, unknown>) => Promise<Response> },
  ) {
    app.get("/api/projects/:id/nfr", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      return c.json(await view(p));
    });

    /** システムの性格（推奨水準の元になる） */
    app.put("/api/projects/:id/nfr/profile", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const profile = (await ctx.body(c, ProfileInput)) as NfrProfile;
      const s = await load(p.id);
      await store.saveNfrSheet({ ...s, profile });
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "nfr.profile", targetType: "project", targetId: p.id, detail: { before: s.profile, after: profile } });
      return c.json(await view(p));
    });

    app.patch("/api/projects/:id/nfr/items/:key", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const item = NFR_ITEM_BY_KEY.get(c.req.param("key"));
      if (!item) throw new HTTPException(404, { message: "非機能要件の項目が見つかりません" });
      const input = await ctx.body(c, ItemInput);
      const s = await load(p.id);
      const before = s.decisions[item.key] ?? empty();
      const next: NfrDecision = {
        ...before,
        status: input.status,
        level: input.level !== undefined ? input.level : before.level,
        value: input.value ?? before.value,
        rationale: input.rationale ?? before.rationale,
        owner: input.owner ?? before.owner,
        updatedBy: ctx.actorOf(c),
        updatedAt: new Date().toISOString(),
      };
      if (next.level && !item.levels.some((l) => l.id === next.level)) throw new HTTPException(400, { message: `水準がありません: ${next.level}` });
      if (next.status === "decided" && !next.level && !next.value.trim()) throw new HTTPException(400, { message: "水準を選ぶか、値を入力してください" });
      if (next.status === "decided" && next.level) next.value = "";
      s.decisions[item.key] = next;
      await store.saveNfrSheet(s);
      await audit(store, {
        orgId: p.orgId,
        actor: ctx.actorOf(c),
        action: "nfr.item",
        targetType: "project",
        targetId: p.id,
        detail: { key: item.key, name: item.name, before: { status: before.status, level: before.level, value: before.value }, after: { status: next.status, level: next.level, value: next.value }, rationale: next.rationale },
      });
      return c.json(await view(p));
    });

    /** 複数AIに推奨水準を提案させる（既定では未検討の項目だけ） */
    app.post("/api/projects/:id/nfr/suggest", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, SuggestInput);
      if (jobs.wantsAsync(c)) {
        await ctx.budget(p.orgId, []);
        return jobs.enqueue(c, p, "nfr", input);
      }
      return c.json(await executeSuggest(p, input, ctx.actorOf(c)), 201);
    });

    /** AIの意見が一致した提案を、未検討の項目にまとめて採用する（意見が分かれた項目は人が決める） */
    app.post("/api/projects/:id/nfr/apply-suggestions", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, ApplyInput);
      const s = await load(p.id);
      const applied: string[] = [];
      for (const sg of s.suggestions?.items ?? []) {
        if (sg.split || !sg.consensus || (input.keys && !input.keys.includes(sg.key))) continue;
        if ((s.decisions[sg.key]?.status ?? "undecided") !== "undecided") continue;
        const why = sg.proposals.map((x) => x.rationale).find(Boolean) ?? "";
        s.decisions[sg.key] = {
          ...empty(),
          status: "decided",
          level: sg.consensus,
          rationale: `AIの提案（${sg.proposals.length}件が一致）${why ? `：${why}` : ""}`,
          updatedBy: ctx.actorOf(c),
          updatedAt: new Date().toISOString(),
        };
        applied.push(sg.key);
      }
      await store.saveNfrSheet(s);
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "nfr.item", targetType: "project", targetId: p.id, detail: { appliedSuggestions: applied } });
      return c.json({ applied, sheet: await view(p) });
    });

    /** 決めた水準から EARS の非機能要件を作る・直す（確定後は変更要求にする） */
    app.post("/api/projects/:id/nfr/requirements", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const { systemName } = await ctx.body(c, RequirementsInput);
      const s = await load(p.id);
      const baselined = await store.latestBaseline(p.id);
      const actor = ctx.actorOf(c);
      const added: string[] = [];
      const updated: string[] = [];
      const changeRequests: string[] = [];
      const skipped: string[] = [];
      for (const item of NFR_ITEMS) {
        const d = s.decisions[item.key];
        if (!d) continue;
        const req = nfrRequirement(item, d, systemName);
        const current = d.requirementId ? await store.getRequirement(d.requirementId) : null;
        const alive = current && !current.deletedAt ? current : null;
        if (!req) {
          if (alive && d.status === "decided") skipped.push(`${item.name}（${alive.code} は今の水準では不要です。必要なら削除してください）`);
          continue;
        }
        if (alive && alive.title === req.title) continue;
        const reason = `非機能要件シート（${item.name}）`;
        if (baselined) {
          const cr = await store.addChangeRequest({
            projectId: p.id,
            kind: alive ? "modify" : "add",
            requirementId: alive?.id ?? null,
            requirementCode: alive?.code ?? null,
            proposal: { title: req.title, description: d.rationale, priority: "must", type: "NFR", ears: req.ears },
            reason,
            source: "nfr",
            createdBy: actor,
          });
          changeRequests.push(cr.code);
        } else if (alive) {
          await store.updateRequirement(alive.id, { title: req.title, ears: req.ears, description: d.rationale }, actor, reason);
          updated.push(alive.code);
        } else {
          const [r] = await store.addRequirements(p.id, [
            { title: req.title, description: d.rationale, type: "NFR", priority: "must", ears: req.ears, roundId: null, source: reason, phaseKey: "quality" },
          ]);
          d.requirementId = r!.id;
          added.push(r!.code);
        }
      }
      await store.saveNfrSheet(s);
      await audit(store, { orgId: p.orgId, actor, action: "nfr.requirements", targetType: "project", targetId: p.id, detail: { added, updated, changeRequests } });
      return c.json({ added, updated, changeRequests, skipped, sheet: await view(p) }, 201);
    });
  }

  /** 仕様書に載せる非機能要件シート */
  async function specMore(p: Project): Promise<Array<{ title: string; lines: string[] }>> {
    const s = await store.getNfrSheet(p.id);
    const g = gradesOf(s?.profile ?? {});
    const ev = evaluateNfr(s?.profile ?? {}, s?.decisions ?? {});
    return [
      {
        title: "13. 非機能要件シート",
        lines: [
          `システムの重要度：${GRADE_LABELS[g.overall]}${s && Object.keys(s.profile).length ? "" : "（システムの性格が未回答のため「中」とみなしています）"}／検討済み ${Math.round(ev.coverage * 100)}%`,
          ...ev.findings.map((f) => `${f.severity === "error" ? "【要対応】" : "【確認】"}${f.message}`),
          ...nfrSheetLines(s?.profile ?? {}, s?.decisions ?? {}),
        ],
      },
    ];
  }

  return {
    routes,
    gate,
    specMore,
    jobHandler: (p: Project, input: unknown, actor: string, report: (pr: JobProgress) => Promise<void>) => executeSuggest(p, ctx.parseOrThrow(SuggestInput, input), actor, report),
  };
}
