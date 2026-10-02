import {
  createProvider,
  detectAmbiguity,
  getPhase,
  PHASES,
  RoundError,
  runRound,
  buildDiagrams,
  generateUmlModel,
  type AIProvider,
  type FetchLike,
  type RequirementItem,
} from "@arn/ai-core";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { hasRole, type Authenticator, type Principal, type Role } from "./auth.js";
import { maskKey, type KeyEncryptor } from "./crypto.js";
import { buildSpec, CONTENT_TYPE, PdfFontMissingError, renderDocx, renderMarkdown, renderPdf, type SpecFormat, type SpecImage } from "./spec.js";
import type { ArtifactStorage } from "./storage.js";
import { usageOf, type CredentialPatch, type Project, type ProviderCredential, type Store } from "./store.js";
import { checkBudget, usageReport } from "./usage.js";

export interface AppDeps {
  store: Store;
  encryptor: KeyEncryptor;
  storage: ArtifactStorage;
  authenticate: Authenticator;
  /** 模擬AI（vendor: mock）を許可するか。本番では false */
  allowMock: boolean;
  /** POST /orgs に必要なトークン。未設定なら dev 認証時のみ組織を作成できる */
  bootstrapToken?: string;
  devAuth: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  random?: () => number;
  /** 月間上限の「月」を数えるタイムゾーン（既定: Asia/Tokyo） */
  usageTimezone?: string;
  /** 現在時刻（テスト用） */
  now?: () => Date;
}

type Env = { Variables: { principal: Principal } };

const VendorSchema = z.enum(["anthropic", "openai", "gemini", "ollama", "mock"]);
const CredentialInput = z.object({
  vendor: VendorSchema,
  model: z.string().min(1).max(200),
  label: z.string().max(100).optional(),
  apiKey: z.string().min(1).max(500).optional(),
  endpoint: z.string().url().optional(),
  monthlyTokenLimit: z.number().int().positive().nullable().optional(),
});
/** 登録済みAIの変更。種類（vendor）は変えられない。apiKey を省略すると今のキーを使い続ける */
const CredentialPatchInput = z
  .object({
    model: z.string().min(1).max(200).optional(),
    label: z.string().min(1).max(100).optional(),
    endpoint: z.string().url().nullable().optional(),
    apiKey: z.string().min(1).max(500).optional(),
    monthlyTokenLimit: z.number().int().positive().nullable().optional(),
  })
  .strict();
const LimitInput = z.object({ monthlyTokenLimit: z.number().int().positive().nullable() });
const ProjectInput = z.object({
  name: z.string().min(1).max(200),
  purpose: z.string().max(2000).default(""),
  confidential: z.boolean().default(false),
  aiConfig: z.object({
    mode: z.enum(["single", "multi"]),
    generatorIds: z.array(z.string()).min(1).max(4),
    evaluatorId: z.string().nullable().default(null),
  }),
});
const RoundInput = z.object({ answer: z.string().min(1).max(10_000), phaseKey: z.string().optional() });
const DecisionInput = z.object({
  /** "A" などの案ラベル、または "merged"（評価AIの統合案） */
  pick: z.string().min(1),
  /** 採用する項目の番号。省略時は全項目 */
  itemIndexes: z.array(z.number().int().min(0)).optional(),
  reason: z.string().max(2000).default(""),
  advancePhase: z.boolean().default(true),
});

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "JSONの形式が正しくありません" });
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new HTTPException(400, { message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return r.data;
}

function publicCredential(c: ProviderCredential) {
  return {
    id: c.id,
    vendor: c.vendor,
    model: c.model,
    label: c.label,
    endpoint: c.endpoint,
    apiKey: maskKey(c.keyLast4),
    isLocal: c.isLocal,
    monthlyTokenLimit: c.monthlyTokenLimit,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function createApp(deps: AppDeps) {
  const { store } = deps;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof RoundError) {
      const status = err.code === "all_failed" ? 502 : 400;
      return c.json({ error: err.message, code: err.code, failures: err.failures }, status);
    }
    console.error(err);
    return c.json({ error: "サーバー内部でエラーが発生しました" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/meta", (c) => c.json({ phases: PHASES, allowMock: deps.allowMock, auth: deps.devAuth ? "dev" : "oidc" }));

  /* ---------- 組織の作成（初期セットアップ） ---------- */
  app.post("/api/orgs", async (c) => {
    const token = c.req.header("x-bootstrap-token");
    const allowed = deps.bootstrapToken ? token === deps.bootstrapToken : deps.devAuth;
    if (!allowed) throw new HTTPException(403, { message: "組織の作成には初期セットアップ用トークンが必要です" });
    const { name } = await body(c, z.object({ name: z.string().min(1).max(200) }));
    return c.json(await store.createOrg(name), 201);
  });

  /* ---------- 以降は認証必須 ---------- */
  app.use("/api/*", async (c, next) => {
    const p = await deps.authenticate(c.req.raw);
    if (!p) throw new HTTPException(401, { message: "ログインが必要です" });
    c.set("principal", p);
    await next();
  });

  const need = (c: Context<Env>, orgId: string, role: Role) => {
    const p = c.get("principal");
    if (p.orgId !== orgId) throw new HTTPException(404, { message: "見つかりません" });
    if (!hasRole(p, role)) throw new HTTPException(403, { message: `この操作には ${role} 以上の権限が必要です` });
  };
  const loadProject = async (c: Context<Env>, id: string, role: Role): Promise<Project> => {
    const p = await store.getProject(id);
    if (!p) throw new HTTPException(404, { message: "プロジェクトが見つかりません" });
    need(c, p.orgId, role);
    return p;
  };

  /** 組織に登録されたAIを復号してプロバイダにする */
  const providersOf = async (project: Project, ids: string[]): Promise<AIProvider[]> => {
    const creds = new Map((await store.listCredentials(project.orgId)).map((x) => [x.id, x]));
    return Promise.all(
      ids.map(async (id) => {
        const cr = creds.get(id);
        if (!cr) throw new HTTPException(400, { message: `AIの登録が削除されています: ${id}` });
        const apiKey = cr.encryptedKey ? await deps.encryptor.decrypt(cr.encryptedKey, { orgId: project.orgId }) : undefined;
        return createProvider(
          { id: cr.id, vendor: cr.vendor, model: cr.model, label: cr.label, apiKey, endpoint: cr.endpoint ?? undefined },
          { fetchImpl: deps.fetchImpl, allowMock: deps.allowMock },
        );
      }),
    );
  };

  const tz = deps.usageTimezone ?? "Asia/Tokyo";
  const nowFn = deps.now ?? (() => new Date());
  /** 今月の利用量から、使えるAIと警告を決める。組織の上限に達していれば 429 */
  const budget = async (orgId: string, ids: string[]) => {
    const org = await store.getOrg(orgId);
    const report = await usageReport(store, orgId, org?.monthlyTokenLimit ?? null, await store.listCredentials(orgId), tz, nowFn());
    const b = checkBudget(report, ids);
    if (b.blocked) throw new HTTPException(429, { message: b.blocked });
    return b;
  };

  /* ---------- 組織 ---------- */
  app.get("/api/orgs/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "viewer");
    const org = await store.getOrg(orgId);
    if (!org) throw new HTTPException(404, { message: "見つかりません" });
    return c.json(org);
  });

  /** 組織全体の月間トークン上限（null で上限なし） */
  app.put("/api/orgs/:orgId/limits", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const { monthlyTokenLimit } = await body(c, LimitInput);
    const org = await store.setOrgLimit(orgId, monthlyTokenLimit);
    if (!org) throw new HTTPException(404, { message: "見つかりません" });
    return c.json(org);
  });

  /* ---------- AIの接続情報（組織の管理者が登録） ---------- */
  app.get("/api/orgs/:orgId/providers", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "viewer");
    return c.json((await store.listCredentials(orgId)).map(publicCredential));
  });

  app.post("/api/orgs/:orgId/providers", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const input = await body(c, CredentialInput);
    if (input.vendor === "mock" && !deps.allowMock) throw new HTTPException(400, { message: "模擬AIは無効化されています" });
    const needsKey = input.vendor === "anthropic" || input.vendor === "openai" || input.vendor === "gemini";
    if (needsKey && !input.apiKey) throw new HTTPException(400, { message: `${input.vendor} にはAPIキーが必要です` });
    const cred = await store.addCredential({
      orgId,
      vendor: input.vendor,
      model: input.model,
      label: input.label ?? `${input.vendor} (${input.model})`,
      endpoint: input.endpoint ?? null,
      encryptedKey: input.apiKey ? await deps.encryptor.encrypt(input.apiKey, { orgId }) : null,
      keyLast4: input.apiKey ? input.apiKey.slice(-4) : null,
      isLocal: input.vendor === "ollama",
      monthlyTokenLimit: input.monthlyTokenLimit ?? null,
    });
    return c.json(publicCredential(cred), 201);
  });

  /** 登録済みAIの変更（モデル名・表示名・接続先・APIキー・月間上限） */
  app.patch("/api/orgs/:orgId/providers/:id", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const input = await body(c, CredentialPatchInput);
    const current = (await store.listCredentials(orgId)).find((x) => x.id === c.req.param("id"));
    if (!current) throw new HTTPException(404, { message: "見つかりません" });
    const patch: CredentialPatch = {
      model: input.model,
      label: input.label,
      endpoint: input.endpoint,
      monthlyTokenLimit: input.monthlyTokenLimit,
    };
    if (input.apiKey) {
      patch.encryptedKey = await deps.encryptor.encrypt(input.apiKey, { orgId });
      patch.keyLast4 = input.apiKey.slice(-4);
    }
    const updated = await store.updateCredential(orgId, current.id, patch);
    if (!updated) throw new HTTPException(404, { message: "見つかりません" });
    return c.json(publicCredential(updated));
  });

  app.delete("/api/orgs/:orgId/providers/:id", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const ok = await store.deleteCredential(orgId, c.req.param("id"));
    if (!ok) throw new HTTPException(404, { message: "見つかりません" });
    return c.body(null, 204);
  });

  app.get("/api/orgs/:orgId/usage", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const org = await store.getOrg(orgId);
    return c.json(await usageReport(store, orgId, org?.monthlyTokenLimit ?? null, await store.listCredentials(orgId), tz, nowFn()));
  });

  /* ---------- プロジェクト ---------- */
  app.post("/api/orgs/:orgId/projects", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "editor");
    const input = await body(c, ProjectInput);
    const creds = new Map((await store.listCredentials(orgId)).map((x) => [x.id, x]));
    const ids = [...input.aiConfig.generatorIds, ...(input.aiConfig.evaluatorId ? [input.aiConfig.evaluatorId] : [])];
    const unknown = ids.filter((id) => !creds.has(id));
    if (unknown.length) throw new HTTPException(400, { message: `組織に登録されていないAIです: ${unknown.join(", ")}` });
    if (input.aiConfig.mode === "single" && input.aiConfig.generatorIds.length !== 1)
      throw new HTTPException(400, { message: "単一AIモードでは生成AIを1つだけ選んでください" });
    if (input.aiConfig.mode === "multi" && input.aiConfig.generatorIds.length < 2)
      throw new HTTPException(400, { message: "複数AIモードでは生成AIを2つ以上選んでください" });
    if (input.confidential && ids.some((id) => !creds.get(id)!.isLocal))
      throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを選べます" });
    return c.json(await store.createProject({ orgId, ...input }), 201);
  });

  app.get("/api/projects/:id", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    return c.json({ ...p, phase: PHASES.find((x) => x.key === p.phaseKey) ?? null });
  });

  app.post("/api/projects/:id/ambiguity", async (c) => {
    await loadProject(c, c.req.param("id"), "viewer");
    const { text } = await body(c, z.object({ text: z.string().max(10_000) }));
    return c.json(detectAmbiguity(text));
  });

  /* ---------- 生成ラウンド: 並列生成 → 匿名化 → 評価 ---------- */
  app.post("/api/projects/:id/rounds", async (c) => {
    const project = await loadProject(c, c.req.param("id"), "editor");
    const input = await body(c, RoundInput);
    if (project.phaseKey === "done" && !input.phaseKey) throw new HTTPException(400, { message: "すべてのフェーズが完了しています" });
    const phase = (() => {
      try {
        return getPhase(input.phaseKey ?? project.phaseKey);
      } catch (e) {
        throw new HTTPException(400, { message: (e as Error).message });
      }
    })();

    const creds = new Map((await store.listCredentials(project.orgId)).map((x) => [x.id, x]));
    const build = async (id: string): Promise<AIProvider> => {
      const cr = creds.get(id);
      if (!cr) throw new HTTPException(400, { message: `AIの登録が削除されています: ${id}` });
      const apiKey = cr.encryptedKey ? await deps.encryptor.decrypt(cr.encryptedKey, { orgId: project.orgId }) : undefined;
      return createProvider(
        { id: cr.id, vendor: cr.vendor, model: cr.model, label: cr.label, apiKey, endpoint: cr.endpoint ?? undefined },
        { fetchImpl: deps.fetchImpl, allowMock: deps.allowMock },
      );
    };
    // 今月の上限: 組織の上限なら停止、AI個別の上限ならそのAIを外して続行
    const evaluatorId = project.aiConfig.mode === "multi" ? project.aiConfig.evaluatorId : null;
    const b = await budget(project.orgId, [...project.aiConfig.generatorIds, ...(evaluatorId ? [evaluatorId] : [])]);
    const generatorIds = project.aiConfig.generatorIds.filter((id) => !b.excluded.has(id));
    if (!generatorIds.length) throw new HTTPException(429, { message: `生成AIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const generators = await Promise.all(generatorIds.map(build));
    const evaluator = evaluatorId && !b.excluded.has(evaluatorId) ? await build(evaluatorId) : undefined;
    if (evaluatorId && !evaluator) b.warnings.push("評価AIが使えないため、今回は評価なしで案を表示します。");

    const existing = await store.listRequirements(project.id);
    const result = await runRound(
      {
        phase,
        projectName: project.name,
        projectPurpose: project.purpose,
        existingRequirements: existing.map((r) => ({ ...r, code: r.code })),
        userAnswer: input.answer,
      },
      { generators, evaluator, confidential: project.confidential, timeoutMs: deps.timeoutMs, random: deps.random },
    );
    result.warnings.unshift(...b.warnings);

    for (const cand of result.candidates)
      await store.addUsage({ orgId: project.orgId, providerId: cand.providerId, projectId: project.id, ...usageOf(cand.usage) });
    if (result.evaluation)
      await store.addUsage({
        orgId: project.orgId,
        providerId: result.evaluation.evaluatorId,
        projectId: project.id,
        ...usageOf(result.evaluation.usage),
      });

    const round = await store.saveRound({
      projectId: project.id,
      phaseKey: phase.key,
      answer: input.answer,
      candidates: result.candidates.map((x) => ({ label: x.label, providerId: x.providerId, content: x.content })),
      evaluation: result.evaluation ?? null,
      failures: result.failures,
      warnings: result.warnings,
      status: "awaiting_decision",
    });

    // 決定前は、どの案がどのAIのものかを返さない
    const ev = result.evaluation;
    return c.json(
      {
        id: round.id,
        phase: { key: phase.key, name: phase.name },
        candidates: result.candidates.map((x) => ({ label: x.label, content: x.content, latencyMs: x.latencyMs })),
        evaluation: ev
          ? {
              evaluator: evaluator?.label,
              scores: ev.scores,
              totals: ev.totals,
              comments: ev.comments,
              recommendedLabel: ev.recommendedLabel,
              recommendation: ev.recommendation,
              merged: ev.merged,
              mergedTotal: ev.mergedTotal,
            }
          : null,
        failures: result.failures.map((f) => ({ provider: creds.get(f.providerId)?.label ?? f.providerId, reason: f.reason })),
        warnings: result.warnings,
        ambiguity: detectAmbiguity(input.answer),
      },
      201,
    );
  });

  app.post("/api/rounds/:id/decision", async (c) => {
    const round = await store.getRound(c.req.param("id"));
    if (!round) throw new HTTPException(404, { message: "見つかりません" });
    const project = await loadProject(c, round.projectId, "editor");
    if (round.status === "decided") throw new HTTPException(409, { message: "このラウンドは決定済みです" });
    const input = await body(c, DecisionInput);

    const content =
      input.pick === "merged" ? round.evaluation?.merged : round.candidates.find((x) => x.label === input.pick)?.content;
    if (!content) throw new HTTPException(400, { message: `選択肢がありません: ${input.pick}` });
    const picked: RequirementItem[] = input.itemIndexes
      ? input.itemIndexes.map((i) => {
          const it = content.items[i];
          if (!it) throw new HTTPException(400, { message: `項目番号が範囲外です: ${i}` });
          return it;
        })
      : content.items;
    if (!picked.length) throw new HTTPException(400, { message: "採用する項目を1つ以上選んでください" });

    const creds = new Map((await store.listCredentials(project.orgId)).map((x) => [x.id, x.label]));
    const mapping = Object.fromEntries(round.candidates.map((x) => [x.label, creds.get(x.providerId) ?? x.providerId]));
    const pickName = input.pick === "merged" ? "統合案" : `案${input.pick}`;
    const added = await store.addRequirements(
      project.id,
      picked.map((it) => ({ ...it, roundId: round.id, source: pickName })),
    );
    const decision = await store.addDecision({ projectId: project.id, roundId: round.id, pick: pickName, reason: input.reason, mapping });
    await store.markRoundDecided(round.id);

    let nextPhase: string | null = project.phaseKey;
    if (input.advancePhase && round.phaseKey === project.phaseKey) {
      const i = PHASES.findIndex((p) => p.key === project.phaseKey);
      nextPhase = PHASES[i + 1]?.key ?? "done";
      await store.setProjectPhase(project.id, nextPhase);
    }
    return c.json({ added, decision, mapping, nextPhase }, 201);
  });

  /* ---------- 要件・成果物 ---------- */
  app.get("/api/projects/:id/requirements", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    return c.json(await store.listRequirements(p.id));
  });

  app.get("/api/projects/:id/decisions", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    return c.json(await store.listDecisions(p.id));
  });

  /* ---------- UML ---------- */
  const diagramsOf = async (p: Project) => {
    const reqs = (await store.listRequirements(p.id)).map((r) => ({ code: r.code, type: r.type, title: r.title }));
    const rec = await store.latestUmlModel(p.id);
    return { diagrams: buildDiagrams(p.name, reqs, rec?.model), rec, reqs };
  };

  app.get("/api/projects/:id/uml", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    const { diagrams, rec } = await diagramsOf(p);
    return c.json({ diagrams, model: rec ? { providerId: rec.providerId, createdAt: rec.createdAt } : null });
  });

  /** AIが要件から設計モデル（クラス・シーケンス・状態・アクティビティ）を作る */
  app.post("/api/projects/:id/uml/generate", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "editor");
    const reqs = (await store.listRequirements(p.id)).map((r) => ({ code: r.code, type: r.type, title: r.title }));
    if (!reqs.length) throw new HTTPException(400, { message: "要件がまだありません。ヒアリングで要件を確定してから生成してください" });
    // 生成AI → 評価AI の順に試す（評価AIは設計の確認役としても使える）
    const ids = [...new Set([...p.aiConfig.generatorIds, ...(p.aiConfig.evaluatorId ? [p.aiConfig.evaluatorId] : [])])];
    const b = await budget(p.orgId, ids);
    const usable = ids.filter((id) => !b.excluded.has(id));
    if (!usable.length) throw new HTTPException(429, { message: `使えるAIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const providers = await providersOf(p, usable);
    if (p.confidential && providers.some((x) => !x.isLocal)) throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    let result: Awaited<ReturnType<typeof generateUmlModel>>;
    try {
      result = await generateUmlModel(providers, p.name, p.purpose, reqs, deps.timeoutMs);
    } catch (e) {
      const failures = (e as { failures?: Array<{ providerId: string; reason: string }> }).failures ?? [];
      return c.json({ error: (e as Error).message, failures }, 502);
    }
    await store.addUsage({ orgId: p.orgId, providerId: result.providerId, projectId: p.id, ...usageOf(result.usage) });
    const rec = await store.saveUmlModel(p.id, result.model, result.providerId);
    const label = providers.find((x) => x.id === result.providerId)?.label ?? result.providerId;
    return c.json(
      {
        diagrams: buildDiagrams(p.name, reqs, rec.model),
        model: { providerId: rec.providerId, provider: label, createdAt: rec.createdAt },
        dropped: result.dropped,
        failures: result.failures,
        warnings: b.warnings,
      },
      201,
    );
  });

  /* ---------- 仕様書（Markdown / Word / PDF） ---------- */
  const ImageInput = z.object({
    title: z.string().min(1).max(200),
    png: z.string().max(8_000_000), // Base64
    width: z.number().int().min(1).max(10_000),
    height: z.number().int().min(1).max(20_000),
  });
  const ExportInput = z.object({
    format: z.enum(["md", "docx", "pdf"]).default("md"),
    /** 画面で描画した図のPNG。省略時は図のソースを載せる */
    images: z.array(ImageInput).max(20).default([]),
    /** 保存先（ローカルボリューム / S3）に版として残すか */
    save: z.boolean().default(true),
  });

  const renderSpec = async (p: Project, format: SpecFormat, images: SpecImage[]) => {
    const { diagrams } = await diagramsOf(p);
    const spec = buildSpec(p, await store.listRequirements(p.id), await store.listDecisions(p.id), diagrams);
    try {
      if (format === "docx") return await renderDocx(spec, images);
      if (format === "pdf") return await renderPdf(spec, images);
      return Buffer.from(renderMarkdown(spec), "utf8");
    } catch (e) {
      if (e instanceof PdfFontMissingError) throw new HTTPException(501, { message: e.message });
      throw e;
    }
  };
  const fileResponse = (c: Context, p: Project, format: SpecFormat, buf: Buffer, key?: string) => {
    const ascii = `spec.${format}`;
    const utf8 = encodeURIComponent(`${p.name}_要件定義書.${format}`);
    const headers: Record<string, string> = {
      "content-type": CONTENT_TYPE[format],
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    };
    if (key) headers["x-artifact-key"] = key;
    return c.body(new Uint8Array(buf), 200, headers);
  };

  for (const format of ["md", "docx", "pdf"] as const) {
    app.get(`/api/projects/:id/spec.${format}`, async (c) => {
      const p = await loadProject(c, c.req.param("id"), "viewer");
      return fileResponse(c, p, format, await renderSpec(p, format, []));
    });
  }

  /** 仕様書を出力し、保存先（ローカルボリューム / S3）に版として残す */
  app.post("/api/projects/:id/exports", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "editor");
    const raw = await c.req.text();
    let json: unknown = {};
    try {
      if (raw.trim()) json = JSON.parse(raw);
    } catch {
      throw new HTTPException(400, { message: "JSONの形式が正しくありません" });
    }
    const parsed = ExportInput.safeParse(json);
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const input = parsed.data;
    const images: SpecImage[] = input.images.map((i) => ({ title: i.title, png: Buffer.from(i.png, "base64"), width: i.width, height: i.height }));
    for (const img of images) {
      if (img.png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new HTTPException(400, { message: `PNG画像ではありません: ${img.title}` });
    }
    const buf = await renderSpec(p, input.format, images);
    let key: string | undefined;
    if (input.save) {
      key = `${p.orgId}/${p.id}/spec-${new Date().toISOString().replace(/[:.]/g, "-")}.${input.format}`;
      await deps.storage.put(key, buf, CONTENT_TYPE[input.format]);
    }
    return fileResponse(c, p, input.format, buf, key);
  });

  return app;
}
