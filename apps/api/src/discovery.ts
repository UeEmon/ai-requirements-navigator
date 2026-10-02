/**
 * 資料の取り込みと分析の API（機能 F2-6 / F2-7）。
 * - 議事録・既存システムの資料・業務マニュアルを取り込み、本文のテキストだけを保存する
 * - AIが現状の業務フロー・課題（資料の引用つき）・業務の見直し案・見直し後のフロー・初回の要件案（EARS）を作る
 *   複数AIモードでは各AIの分析を匿名で比較し、利用者が1つを選ぶ
 * - 採用する見直し案と要件を選んで要件にする（要件定義の確定後は「追加」の変更要求にする）
 */
import {
  analyzeDocuments,
  APPROACHES,
  businessFlowDiagrams,
  ISSUE_CATEGORIES,
  type Diagram,
  type SourceDocument,
} from "@arn/ai-core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import { ExtractError, extractText, MAX_UPLOAD_BYTES } from "./extract.js";
import type { AnyContext, ImplementationContext } from "./implementation.js";
import type { AnalysisRecord, JobProgress, Project, ProjectDocument } from "./store.js";
import { usageOf } from "./store.js";

export const DOCUMENT_KINDS = { minutes: "議事録", existing: "既存システムの資料", business: "業務マニュアル・規程", other: "その他" } as const;

const DocumentInput = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(Object.keys(DOCUMENT_KINDS) as [keyof typeof DOCUMENT_KINDS]).default("other"),
    /** 貼り付けた文章 */
    text: z.string().max(400_000).optional(),
    /** ファイルの中身（Base64） */
    contentBase64: z.string().max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 16).optional(),
    mime: z.string().max(200).default(""),
  })
  .refine((d) => Boolean(d.text) !== Boolean(d.contentBase64), { message: "text か contentBase64 のどちらか一方を指定してください" });
const AnalyzeInput = z.object({
  /** 省略時はプロジェクトのすべての資料 */
  documentIds: z.array(z.string()).max(20).optional(),
  focus: z.string().max(1000).default(""),
});
const AdoptInput = z.object({
  label: z.string().min(1),
  /** 採用する見直し案 */
  proposalIds: z.array(z.string()).max(50).default([]),
  /** 要件にする要件案の番号 */
  requirementIndexes: z.array(z.number().int().min(0)).max(100),
  reason: z.string().max(2000).default(""),
});

const TYPE_PHASE: Record<string, string> = { BR: "purpose", AC: "actors", FR: "functions", NFR: "quality", CN: "constraints" };

export function discovery(ctx: ImplementationContext) {
  const { store } = ctx;

  const docView = (d: ProjectDocument) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    kindLabel: DOCUMENT_KINDS[d.kind as keyof typeof DOCUMENT_KINDS] ?? d.kind,
    format: d.format,
    chars: d.chars,
    truncated: d.truncated,
    preview: d.text.slice(0, 200),
    createdBy: d.createdBy,
    createdAt: d.createdAt,
  });

  /** 採用前はどの案がどのAIのものかを返さない */
  const analysisView = async (a: AnalysisRecord, orgId: string) => {
    const labels = await ctx.labelsOf(orgId);
    const reveal = a.status === "adopted";
    return {
      id: a.id,
      status: a.status,
      documentIds: a.documentIds,
      focus: a.focus,
      createdAt: a.createdAt,
      candidates: a.candidates.map((c) => ({ label: c.label, analysis: c.analysis, ...(reveal ? { provider: labels.get(c.providerId) ?? c.providerId } : {}) })),
      evaluation: a.evaluation
        ? { evaluator: labels.get(a.evaluation.evaluatorId) ?? a.evaluation.evaluatorId, scores: a.evaluation.scores, totals: a.evaluation.totals, comments: a.evaluation.comments, recommendedLabel: a.evaluation.recommendedLabel, recommendation: a.evaluation.recommendation }
        : null,
      failures: a.failures.map((f) => ({ provider: labels.get(f.providerId) ?? f.providerId, reason: f.reason })),
      warnings: a.warnings,
      notes: a.notes,
      adoption: a.adoption,
      mapping: reveal ? Object.fromEntries(a.candidates.map((c) => [c.label, labels.get(c.providerId) ?? c.providerId])) : null,
    };
  };

  async function executeAnalysis(p: Project, input: z.infer<typeof AnalyzeInput>, actor: string, report?: (pr: JobProgress) => Promise<void>) {
    const all = await store.listDocuments(p.id);
    const docs = input.documentIds ? all.filter((d) => input.documentIds!.includes(d.id)) : all;
    if (!docs.length) throw new HTTPException(400, { message: "資料がありません。先に議事録や既存システムの資料を取り込んでください" });
    if (input.documentIds && docs.length !== new Set(input.documentIds).size) throw new HTTPException(400, { message: "見つからない資料があります" });

    const ids = [...new Set([...p.aiConfig.generatorIds, ...(p.aiConfig.evaluatorId ? [p.aiConfig.evaluatorId] : [])])];
    const b = await ctx.budget(p.orgId, ids);
    const gens = (p.aiConfig.mode === "multi" ? p.aiConfig.generatorIds : p.aiConfig.generatorIds.slice(0, 1)).filter((id) => !b.excluded.has(id));
    if (!gens.length) throw new HTTPException(429, { message: `使えるAIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const evaluatorId = p.aiConfig.mode === "multi" && p.aiConfig.evaluatorId && !b.excluded.has(p.aiConfig.evaluatorId) && gens.length >= 2 ? p.aiConfig.evaluatorId : null;
    const providers = await ctx.providersOf(p.orgId, gens);
    const evaluator = evaluatorId ? (await ctx.providersOf(p.orgId, [evaluatorId]))[0] : undefined;
    if (p.confidential && [...providers, ...(evaluator ? [evaluator] : [])].some((x) => !x.isLocal)) {
      throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    }
    const labels = await ctx.labelsOf(p.orgId);
    const steps: NonNullable<JobProgress["steps"]> = [
      ...gens.map((id) => ({ key: `generator:${id}`, label: `分析: ${labels.get(id) ?? id}`, status: "waiting" as const })),
      ...(evaluatorId ? [{ key: `evaluator:${evaluatorId}`, label: `評価: ${labels.get(evaluatorId) ?? evaluatorId}`, status: "waiting" as const }] : []),
    ];
    let chain = Promise.resolve();
    const push = () => {
      const snap = { steps: steps.map((s) => ({ ...s })) };
      chain = chain.then(() => report?.(snap)).catch(() => undefined);
    };
    push();

    const sources: SourceDocument[] = docs.map((d, i) => ({ key: `D${i + 1}`, name: d.name, kind: DOCUMENT_KINDS[d.kind as keyof typeof DOCUMENT_KINDS] ?? d.kind, text: d.text }));
    const existing = (await store.listRequirements(p.id)).map((r) => ({ code: r.code, title: r.title }));
    let cmp: Awaited<ReturnType<typeof analyzeDocuments>>;
    try {
      cmp = await analyzeDocuments(providers, evaluator, { projectName: p.name, purpose: p.purpose, docs: sources, focus: input.focus, existing }, {
        timeoutMs: ctx.timeoutMs,
        onProgress: (e) => {
          const s = steps.find((x) => x.key === `${e.type}:${e.providerId}`);
          if (!s) return;
          s.status = e.status;
          if (e.reason) s.reason = e.reason;
          push();
        },
      });
    } catch (e) {
      await chain;
      const failures = ((e as { failures?: Array<{ providerId: string; reason: string }> }).failures ?? []).map((f) => `${labels.get(f.providerId) ?? f.providerId}: ${f.reason}`);
      throw new HTTPException(502, { message: `${(e as Error).message}${failures.length ? `（${failures.join(" / ")}）` : ""}` });
    }
    await chain;
    for (const c of cmp.candidates) await store.addUsage({ orgId: p.orgId, providerId: c.providerId, projectId: p.id, ...usageOf(c.usage) });
    if (cmp.evaluation) await store.addUsage({ orgId: p.orgId, providerId: cmp.evaluation.evaluatorId, projectId: p.id, ...usageOf(cmp.evaluation.usage) });
    const evaluation = cmp.evaluation ? (({ usage: _u, ...rest }) => rest)(cmp.evaluation) : null;
    const rec = await store.saveAnalysis({
      projectId: p.id,
      documentIds: docs.map((d) => d.id),
      focus: input.focus,
      candidates: cmp.candidates.map((c) => ({ label: c.label, providerId: c.providerId, analysis: c.analysis })),
      evaluation,
      failures: cmp.failures,
      warnings: [...b.warnings, ...cmp.warnings],
      notes: [...cmp.notes, ...sources.map((s) => `${s.key} = ${s.name}`)],
      createdBy: actor,
    });
    await audit(store, {
      orgId: p.orgId,
      actor,
      action: "ai.analysis",
      targetType: "analysis",
      targetId: rec.id,
      detail: {
        projectId: p.id,
        // 資料の本文は記録せず、名前と文字数だけを残す
        sent: { documents: docs.map((d) => ({ name: d.name, chars: d.chars })), focus: input.focus },
        generators: cmp.candidates.map((c) => ({ id: c.providerId, label: labels.get(c.providerId), tokens: usageOf(c.usage) })),
        evaluator: cmp.evaluation ? { id: cmp.evaluation.evaluatorId, label: labels.get(cmp.evaluation.evaluatorId), tokens: usageOf(cmp.evaluation.usage) } : null,
        failures: cmp.failures.map((f) => ({ id: f.providerId, label: labels.get(f.providerId), reason: f.reason })),
      },
    });
    return analysisView(rec, p.orgId);
  }

  const loadAnalysis = async (c: AnyContext, id: string, role: "viewer" | "editor") => {
    const a = await store.getAnalysis(id);
    if (!a) throw new HTTPException(404, { message: "分析が見つかりません" });
    const p = await ctx.loadProject(c, a.projectId, role);
    return { a, p };
  };

  function routes(
    app: Hono<any>,
    jobs: {
      wantsAsync: (c: Context) => boolean;
      enqueue: (c: AnyContext, p: Project, kind: "analysis", input: Record<string, unknown>) => Promise<Response>;
    },
  ) {
    /* ---------- 資料 ---------- */
    app.get("/api/projects/:id/documents", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      return c.json((await store.listDocuments(p.id)).map(docView));
    });

    app.post("/api/projects/:id/documents", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, DocumentInput);
      let extracted: Awaited<ReturnType<typeof extractText>>;
      try {
        extracted = input.text
          ? await extractText(input.name.match(/\.\w+$/) ? input.name : `${input.name}.txt`, Buffer.from(input.text, "utf8"), "text/plain")
          : await extractText(input.name, Buffer.from(input.contentBase64!, "base64"), input.mime);
      } catch (e) {
        if (e instanceof ExtractError) throw new HTTPException(e.status as 400, { message: e.message });
        throw e;
      }
      const d = await store.addDocument({
        projectId: p.id,
        name: input.name,
        kind: input.kind,
        format: extracted.format,
        text: extracted.text,
        chars: extracted.text.length,
        truncated: extracted.truncated,
        createdBy: ctx.actorOf(c),
      });
      await audit(store, {
        orgId: p.orgId,
        actor: ctx.actorOf(c),
        action: "document.create",
        targetType: "document",
        targetId: d.id,
        detail: { projectId: p.id, name: d.name, kind: d.kind, format: d.format, chars: d.chars, truncated: d.truncated },
      });
      return c.json({ ...docView(d), warnings: d.truncated ? [`本文が長いため、先頭の ${d.chars.toLocaleString()}文字だけを取り込みました`] : [] }, 201);
    });

    app.get("/api/documents/:id", async (c) => {
      const d = await store.getDocument(c.req.param("id"));
      if (!d) throw new HTTPException(404, { message: "資料が見つかりません" });
      await ctx.loadProject(c, d.projectId, "viewer");
      return c.json({ ...docView(d), text: d.text });
    });

    app.delete("/api/documents/:id", async (c) => {
      const d = await store.getDocument(c.req.param("id"));
      if (!d) throw new HTTPException(404, { message: "資料が見つかりません" });
      const p = await ctx.loadProject(c, d.projectId, "editor");
      await store.deleteDocument(d.id);
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "document.delete", targetType: "document", targetId: d.id, detail: { projectId: p.id, name: d.name } });
      return c.body(null, 204);
    });

    /* ---------- 分析 ---------- */
    app.get("/api/projects/:id/analyses", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "viewer");
      return c.json(
        (await store.listAnalyses(p.id)).map((a) => ({ id: a.id, status: a.status, createdAt: a.createdAt, documentIds: a.documentIds, candidates: a.candidates.length, adoption: a.adoption })),
      );
    });

    app.post("/api/projects/:id/analyses", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "editor");
      const input = await ctx.body(c, AnalyzeInput);
      if (jobs.wantsAsync(c)) {
        if (!(await store.listDocuments(p.id)).length) throw new HTTPException(400, { message: "資料がありません。先に議事録や既存システムの資料を取り込んでください" });
        await ctx.budget(p.orgId, []);
        return jobs.enqueue(c, p, "analysis", input);
      }
      return c.json(await executeAnalysis(p, input, ctx.actorOf(c)), 201);
    });

    app.get("/api/analyses/:id", async (c) => {
      const { a, p } = await loadAnalysis(c, c.req.param("id"), "viewer");
      return c.json(await analysisView(a, p.orgId));
    });

    /** 分析の案を1つ選び、採用する見直し案と要件案を要件にする */
    app.post("/api/analyses/:id/adopt", async (c) => {
      const { a, p } = await loadAnalysis(c, c.req.param("id"), "editor");
      if (a.status === "adopted") throw new HTTPException(409, { message: "この分析は採用済みです" });
      const input = await ctx.body(c, AdoptInput);
      const cand = a.candidates.find((x) => x.label === input.label);
      if (!cand) throw new HTTPException(400, { message: `選択肢がありません: ${input.label}` });
      const known = new Set(cand.analysis.proposals.map((x) => x.id));
      const bad = input.proposalIds.filter((x) => !known.has(x));
      if (bad.length) throw new HTTPException(400, { message: `見直し案がありません: ${bad.join(", ")}` });
      const picked = input.requirementIndexes.map((i) => {
        const r = cand.analysis.requirements[i];
        if (!r) throw new HTTPException(400, { message: `要件案の番号が範囲外です: ${i}` });
        return r;
      });
      if (!picked.length) throw new HTTPException(400, { message: "要件にする要件案を1つ以上選んでください" });

      const actor = ctx.actorOf(c);
      const source = `資料分析（案${cand.label}）`;
      const baselined = await store.latestBaseline(p.id);
      const requirementCodes: string[] = [];
      const changeCodes: string[] = [];
      if (baselined) {
        // 確定後は「追加」の変更要求にして、影響を確認してから要件にする
        for (const r of picked) {
          const cr = await store.addChangeRequest({
            projectId: p.id,
            kind: "add",
            requirementId: null,
            requirementCode: null,
            proposal: { title: r.title, description: r.description, priority: r.priority, type: r.type, ears: r.ears ?? null },
            reason: `${source}${r.proposalIds.length ? `・見直し案 ${r.proposalIds.join(",")}` : ""}${r.rationale ? `：${r.rationale}` : ""}`,
            source: "analysis",
            createdBy: actor,
          });
          changeCodes.push(cr.code);
        }
      } else {
        const added = await store.addRequirements(
          p.id,
          picked.map((r) => ({
            title: r.title,
            description: [r.description, r.rationale ? `理由：${r.rationale}` : "", r.proposalIds.length ? `見直し案：${r.proposalIds.join(", ")}` : ""].filter(Boolean).join("／"),
            type: r.type,
            priority: r.priority,
            ears: r.ears,
            roundId: null,
            source,
            phaseKey: TYPE_PHASE[r.type] ?? null,
          })),
        );
        requirementCodes.push(...added.map((r) => r.code));
      }
      const adopted = await store.adoptAnalysis(a.id, { label: cand.label, proposalIds: input.proposalIds, requirementCodes, changeCodes, reason: input.reason, by: actor, at: new Date().toISOString() });
      const view = await analysisView(adopted!, p.orgId);
      await audit(store, {
        orgId: p.orgId,
        actor,
        action: "analysis.adopt",
        targetType: "analysis",
        targetId: a.id,
        detail: { projectId: p.id, pick: `案${cand.label}`, mapping: view.mapping, proposals: input.proposalIds, requirements: requirementCodes, changeRequests: changeCodes, reason: input.reason },
      });
      return c.json({ analysis: view, requirementCodes, changeCodes }, 201);
    });
  }

  /** 仕様書・UMLに載せる、採用した分析（業務フローの図と、課題・見直し案・引き継がないもの） */
  async function specMore(p: Project): Promise<{ diagrams: Diagram[]; extras: Array<{ title: string; lines: string[] }> }> {
    const a = (await store.listAnalyses(p.id)).find((x) => x.status === "adopted");
    if (!a?.adoption) return { diagrams: [], extras: [] };
    const cand = a.candidates.find((x) => x.label === a.adoption!.label);
    if (!cand) return { diagrams: [], extras: [] };
    const an = cand.analysis;
    const accepted = new Set(a.adoption.proposalIds);
    return {
      diagrams: businessFlowDiagrams(an),
      extras: [
        {
          title: "11. 現状の課題（資料分析）",
          lines: an.issues.map(
            (i) => `${i.id} ${i.title}［${ISSUE_CATEGORIES[i.category]}］ 原因：${i.rootCause || "―"}${i.evidence.length ? ` 根拠：${i.evidence.map((e) => `${e.document}「${e.quote}」${e.verified ? "" : "（資料で未確認）"}`).join(" ")}` : ""}`,
          ),
        },
        {
          title: "12. 業務の見直し",
          lines: [
            ...an.proposals.map((x) => `${accepted.has(x.id) ? "採用" : "不採用"}　${x.id} [${APPROACHES[x.approach]}] ${x.title}：${x.description}${x.effect ? ` 効果：${x.effect}` : ""}${x.tradeoff ? ` 注意：${x.tradeoff}` : ""}`),
            ...an.notCarriedOver.map((n) => `引き継がない：${n.item}（${n.reason}）`),
            `見直し率 ${Math.round(an.metrics.reviewRate * 100)}%／根拠を確かめられた課題 ${Math.round(an.metrics.groundedRate * 100)}%`,
          ],
        },
      ],
    };
  }

  return {
    routes,
    specMore,
    jobHandler: (p: Project, input: unknown, actor: string, report: (pr: JobProgress) => Promise<void>) => executeAnalysis(p, ctx.parseOrThrow(AnalyzeInput, input), actor, report),
  };
}
