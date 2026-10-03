import {
  buildDiagrams,
  checkApiKey,
  compareUmlModels,
  VENDOR_INFO,
  vendorName,
  BusinessRule,
  Ears,
  EARS_TYPES,
  lintEars,
  lintRule,
  renderEars,
  screenFlowDiagram,
  createProvider,
  defaultGuide,
  detectAmbiguity,
  generateGuide,
  generateUmlModel,
  getPhase,
  PHASES,
  RoundError,
  runRound,
  type AIProvider,
  type FetchLike,
  type Guide,
  type GuideContext,
  type Phase,
  type ProgressEvent,
  type RequirementItem,
  type UmlModel,
} from "@arn/ai-core";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit, clip } from "./audit.js";
import { hasRole, type Authenticator, type OidcClient, type Principal, type Role, type TokenSet } from "./auth.js";
import { maskKey, type KeyEncryptor } from "./crypto.js";
import { designAndChange } from "./design-change.js";
import { discovery } from "./discovery.js";
import { connect } from "./connect.js";
import { handoff } from "./handoff.js";
import { scope } from "./scope.js";
import { nfrSheet } from "./nfr-sheet.js";
import { loadSample, SAMPLES } from "./samples.js";
import { implementation, type ImplementationContext } from "./implementation.js";
import { JobError, JobRunner, type JobRunnerOptions } from "./jobs.js";
import { buildSpec, CONTENT_TYPE, PdfFontMissingError, renderDocx, renderMarkdown, renderPdf, type SpecFormat, type SpecImage } from "./spec.js";
import type { ArtifactStorage } from "./storage.js";
import {
  usageOf,
  type ApiToken,
  type CredentialPatch,
  type Job,
  type JobProgress,
  type Project,
  type ProviderCredential,
  type Requirement,
  type Store,
} from "./store.js";
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
  /** ログイン画面用（AUTH_MODE=oidc のとき） */
  oidc?: { client: OidcClient; orgClaim: string; roleClaim: string };
  /** このサーバーの外から見たURL（開発用パッケージや AGENTS.md に書く） */
  publicUrl?: string;
  /** Webhook の送り先に社内（プライベート）アドレス・http を許す（ローカルの Docker 向け） */
  webhookAllowPrivate?: boolean;
  /** Webhook の送り先の名前解決（テスト用） */
  webhookLookup?: (host: string) => Promise<Array<{ address: string }>>;
  /** 非同期ジョブを実行するか（既定: true） */
  runJobs?: boolean;
  jobs?: JobRunnerOptions;
}

type Env = { Variables: { principal: Principal; token?: ApiToken } };

/* ------------------------------------------------------------------ */
/* 入力の形                                                             */
/* ------------------------------------------------------------------ */

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
  /** 決定後に次のフェーズへ進むか。画面は観点の網羅状況を見てから進めるため false を送る */
  advancePhase: z.boolean().default(true),
});
const PhaseInput = z.object({ phaseKey: z.string().min(1) });
const GuideInput = z.object({ phaseKey: z.string().optional() });
const RequirementPatchInput = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(2000).optional(),
    priority: z.enum(["must", "should", "could"]).optional(),
    /** 機能要件・非機能要件の EARS の構造。指定すると内容（title）はここから組み立てる。null で構造を外す */
    ears: Ears.nullable().optional(),
    /** 業務ルール（RL）の種類と具体例 */
    rule: BusinessRule.nullable().optional(),
    reason: z.string().max(500).default(""),
  })
  .strict();
const UmlAdoptInput = z.object({ label: z.string().min(1), reason: z.string().max(2000).default("") });
const TokenInput = z.object({ code: z.string().min(1), codeVerifier: z.string().min(43).max(128), redirectUri: z.string().url() });
const RefreshInput = z.object({ refreshToken: z.string().min(1) });

/** 要件文の検査。機能・非機能は EARS の文型、業務ルールは具体例とあいまいな言葉 */
function lintOf(r: { title: string; type: string; rule?: BusinessRule | null }) {
  if (r.type === "RL") {
    const l = lintRule(r.title, r.rule);
    return { pattern: null, ok: l.ok, issues: l.issues.map((x) => x.message) };
  }
  return lintEars(r.title, r.type);
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, json: unknown): z.infer<T> {
  const r = schema.safeParse(json);
  if (!r.success) throw new HTTPException(400, { message: r.error.issues.map((i) => `${i.path.join(".") || "入力"}: ${i.message}`).join("; ") });
  return r.data;
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    const raw = await c.req.text();
    json = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new HTTPException(400, { message: "JSONの形式が正しくありません" });
  }
  return parseOrThrow(schema, json);
}

/** 貼り付けた API キーを確かめる（前後の空白などは取り除く）。キーそのものはメッセージに出さない */
function keyOrThrow(vendor: ProviderCredential["vendor"], raw: string, customEndpoint: boolean): string {
  const r = checkApiKey(vendor, raw, { customEndpoint });
  if (!r.ok) throw new HTTPException(400, { message: r.message });
  return r.key;
}

function publicCredential(c: ProviderCredential) {
  return {
    id: c.id,
    vendor: c.vendor,
    vendorName: vendorName(c.vendor),
    model: c.model,
    label: c.label,
    endpoint: c.endpoint,
    keyName: VENDOR_INFO[c.vendor]?.keyName ?? null,
    apiKey: maskKey(c.keyLast4),
    isLocal: c.isLocal,
    monthlyTokenLimit: c.monthlyTokenLimit,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** 要件がどのフェーズのものか（記録がない古いデータは区分から推定） */
const TYPE_PHASE: Record<string, string> = { BR: "purpose", AC: "actors", FR: "functions", NFR: "quality", CN: "constraints" };
const phaseOfRequirement = (r: Requirement) => r.phaseKey ?? TYPE_PHASE[r.type] ?? "functions";

function nextPhaseKey(key: string): string {
  const i = PHASES.findIndex((p) => p.key === key);
  return PHASES[i + 1]?.key ?? "done";
}

function phaseOrThrow(key: string): Phase {
  try {
    return getPhase(key);
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
}

/* ------------------------------------------------------------------ */
/* アプリ本体                                                           */
/* ------------------------------------------------------------------ */

export function createApp(deps: AppDeps) {
  const { store } = deps;
  const app = new Hono<Env>();
  const tz = deps.usageTimezone ?? "Asia/Tokyo";
  const nowFn = deps.now ?? (() => new Date());

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof RoundError) {
      const status = err.code === "all_failed" ? 502 : 400;
      return c.json({ error: err.message, code: err.code, failures: err.failures }, status);
    }
    if (err instanceof JobError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: "サーバー内部でエラーが発生しました" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/meta", (c) =>
    c.json({
      phases: PHASES,
      allowMock: deps.allowMock,
      // AI の種類ごとの名前と API キーの案内（Claude・ChatGPT・Gemini が標準）
      vendors: Object.values(VENDOR_INFO).filter((v) => v.vendor !== "mock" || deps.allowMock),
      auth: deps.devAuth ? "dev" : "oidc",
      oidc: deps.oidc ? { orgClaim: deps.oidc.orgClaim, roleClaim: deps.oidc.roleClaim } : null,
    }),
  );

  /* ---------- ログイン（OIDC 認可コード＋PKCE。トークン交換はサーバー経由） ---------- */
  app.get("/api/auth/config", async (c) => {
    if (!deps.oidc) throw new HTTPException(404, { message: "ログイン画面は使われていません（AUTH_MODE=dev）" });
    try {
      return c.json(await deps.oidc.client.publicConfig());
    } catch (e) {
      throw new HTTPException(502, { message: (e as Error).message });
    }
  });
  app.post("/api/auth/token", async (c) => {
    if (!deps.oidc) throw new HTTPException(404, { message: "ログイン画面は使われていません" });
    const input = await body(c, TokenInput);
    let tokens: TokenSet;
    try {
      tokens = await deps.oidc.client.exchange(input.code, input.codeVerifier, input.redirectUri);
    } catch (e) {
      throw new HTTPException(401, { message: (e as Error).message });
    }
    const p = await deps.authenticate(new Request("http://local/", { headers: { authorization: `Bearer ${tokens.idToken}` } }));
    if (!p) throw new HTTPException(403, { message: "ログインできましたが、組織または権限が設定されていません。管理者に連絡してください" });
    await audit(store, { orgId: p.orgId, actor: p.userId, action: "auth.login", detail: { role: p.role } });
    return c.json(tokens);
  });
  app.post("/api/auth/refresh", async (c) => {
    if (!deps.oidc) throw new HTTPException(404, { message: "ログイン画面は使われていません" });
    const input = await body(c, RefreshInput);
    try {
      return c.json(await deps.oidc.client.refresh(input.refreshToken));
    } catch (e) {
      throw new HTTPException(401, { message: (e as Error).message });
    }
  });

  /* ---------- 組織の作成（初期セットアップ） ---------- */
  app.post("/api/orgs", async (c) => {
    const token = c.req.header("x-bootstrap-token");
    const allowed = deps.bootstrapToken ? token === deps.bootstrapToken : deps.devAuth;
    if (!allowed) throw new HTTPException(403, { message: "組織の作成には初期セットアップ用トークンが必要です" });
    const { name } = await body(c, z.object({ name: z.string().min(1).max(200) }));
    const org = await store.createOrg(name);
    await audit(store, { orgId: org.id, actor: "bootstrap", action: "org.create", targetType: "org", targetId: org.id, detail: { name } });
    return c.json(org, 201);
  });

  /* ---------- 以降は認証必須 ---------- */
  app.use("/api/*", async (c, next) => {
    // 外部連携 API（/api/v1）はトークンでも使えるため、connect.ts の認証に任せる
    if (c.req.path.startsWith("/api/v1/")) return next();
    const p = await deps.authenticate(c.req.raw);
    if (!p) throw new HTTPException(401, { message: "ログインが必要です" });
    c.set("principal", p);
    await next();
  });

  const actorOf = (c: Context<Env>) => c.get("principal").userId;
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
  const loadRequirement = async (c: Context<Env>, id: string, role: Role) => {
    const r = await store.getRequirement(id);
    if (!r || r.deletedAt) throw new HTTPException(404, { message: "要件が見つかりません" });
    const p = await loadProject(c, r.projectId, role);
    return { r, p };
  };

  /** 組織に登録されたAIを復号してプロバイダにする */
  const providersOf = async (orgId: string, ids: string[]): Promise<AIProvider[]> => {
    const creds = new Map((await store.listCredentials(orgId)).map((x) => [x.id, x]));
    return Promise.all(
      ids.map(async (id) => {
        const cr = creds.get(id);
        if (!cr) throw new HTTPException(400, { message: `AIの登録が削除されています: ${id}` });
        const apiKey = cr.encryptedKey ? await deps.encryptor.decrypt(cr.encryptedKey, { orgId }) : undefined;
        return createProvider(
          { id: cr.id, vendor: cr.vendor, model: cr.model, label: cr.label, apiKey, endpoint: cr.endpoint ?? undefined },
          { fetchImpl: deps.fetchImpl, allowMock: deps.allowMock },
        );
      }),
    );
  };
  const labelsOf = async (orgId: string) => new Map((await store.listCredentials(orgId)).map((x) => [x.id, x.label]));

  /** 今月の利用量から、使えるAIと警告を決める。組織の上限に達していれば 429 */
  const budget = async (orgId: string, ids: string[]) => {
    const org = await store.getOrg(orgId);
    const report = await usageReport(store, orgId, org?.monthlyTokenLimit ?? null, await store.listCredentials(orgId), tz, nowFn());
    const b = checkBudget(report, ids);
    if (b.blocked) throw new HTTPException(429, { message: b.blocked });
    return b;
  };

  /** 進み具合（画面に表示する手順の一覧）を作る */
  const progressTracker = (labels: Map<string, string>, gens: string[], evaluator: string | null, report?: (p: JobProgress) => Promise<void>) => {
    const steps: NonNullable<JobProgress["steps"]> = [
      ...gens.map((id) => ({ key: `generator:${id}`, label: `${labels.get(id) ?? id}`, status: "waiting" as const })),
      ...(evaluator ? [{ key: `evaluator:${evaluator}`, label: `評価: ${labels.get(evaluator) ?? evaluator}`, status: "waiting" as const }] : []),
    ];
    let chain = Promise.resolve();
    const push = () => {
      if (!report) return;
      const snapshot = { steps: steps.map((s) => ({ ...s })) };
      chain = chain.then(() => report(snapshot)).catch(() => undefined);
    };
    push();
    return {
      onProgress: (e: ProgressEvent) => {
        const s = steps.find((x) => x.key === `${e.type}:${e.providerId}`);
        if (!s) return;
        s.status = e.status;
        if (e.reason) s.reason = e.reason;
        push();
      },
      flush: () => chain,
    };
  };

  /* ------------------------------------------------------------------ */
  /* 組織・AI登録・利用量                                                  */
  /* ------------------------------------------------------------------ */

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
    const before = await store.getOrg(orgId);
    const org = await store.setOrgLimit(orgId, monthlyTokenLimit);
    if (!org) throw new HTTPException(404, { message: "見つかりません" });
    await audit(store, {
      orgId,
      actor: actorOf(c),
      action: "org.limits.update",
      targetType: "org",
      targetId: orgId,
      detail: { before: before?.monthlyTokenLimit ?? null, after: monthlyTokenLimit },
    });
    return c.json(org);
  });

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
    const info = VENDOR_INFO[input.vendor];
    if (info.keyName && !input.apiKey) {
      throw new HTTPException(400, { message: `${info.name} には${info.keyName}が必要です（${info.keyHow}）` });
    }
    const apiKey = input.apiKey ? keyOrThrow(input.vendor, input.apiKey, Boolean(input.endpoint)) : undefined;
    const cred = await store.addCredential({
      orgId,
      vendor: input.vendor,
      model: input.model,
      label: input.label ?? `${info.name} (${input.model})`,
      endpoint: input.endpoint ?? null,
      encryptedKey: apiKey ? await deps.encryptor.encrypt(apiKey, { orgId }) : null,
      keyLast4: apiKey ? apiKey.slice(-4) : null,
      isLocal: input.vendor === "ollama",
      monthlyTokenLimit: input.monthlyTokenLimit ?? null,
    });
    await audit(store, {
      orgId,
      actor: actorOf(c),
      action: "provider.create",
      targetType: "provider",
      targetId: cred.id,
      detail: { vendor: cred.vendor, model: cred.model, label: cred.label, endpoint: cred.endpoint, monthlyTokenLimit: cred.monthlyTokenLimit },
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
      const endpoint = input.endpoint !== undefined ? input.endpoint : current.endpoint;
      const apiKey = keyOrThrow(current.vendor, input.apiKey, Boolean(endpoint));
      patch.encryptedKey = await deps.encryptor.encrypt(apiKey, { orgId });
      patch.keyLast4 = apiKey.slice(-4);
    }
    const updated = await store.updateCredential(orgId, current.id, patch);
    if (!updated) throw new HTTPException(404, { message: "見つかりません" });
    const changed = (["model", "label", "endpoint", "monthlyTokenLimit"] as const).filter(
      (k) => input[k] !== undefined && input[k] !== current[k],
    );
    await audit(store, {
      orgId,
      actor: actorOf(c),
      action: "provider.update",
      targetType: "provider",
      targetId: current.id,
      // APIキーそのものは記録しない
      detail: {
        label: updated.label,
        changes: Object.fromEntries(changed.map((k) => [k, { before: current[k], after: updated[k] }])),
        apiKeyChanged: Boolean(input.apiKey),
      },
    });
    return c.json(publicCredential(updated));
  });

  app.delete("/api/orgs/:orgId/providers/:id", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const current = (await store.listCredentials(orgId)).find((x) => x.id === c.req.param("id"));
    const ok = current ? await store.deleteCredential(orgId, current.id) : false;
    if (!ok || !current) throw new HTTPException(404, { message: "見つかりません" });
    await audit(store, {
      orgId,
      actor: actorOf(c),
      action: "provider.delete",
      targetType: "provider",
      targetId: current.id,
      detail: { vendor: current.vendor, model: current.model, label: current.label },
    });
    return c.body(null, 204);
  });

  app.get("/api/orgs/:orgId/usage", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const org = await store.getOrg(orgId);
    return c.json(await usageReport(store, orgId, org?.monthlyTokenLimit ?? null, await store.listCredentials(orgId), tz, nowFn()));
  });

  /** 監査ログ（新しい順。before に前回の最後の id を渡すと続きを返す） */
  app.get("/api/orgs/:orgId/audit", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "admin");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const entries = await store.listAudit(orgId, { limit, before: c.req.query("before") || undefined, action: c.req.query("action") || undefined });
    return c.json({ entries, next: entries.length === limit ? entries.at(-1)!.id : null });
  });

  /* ------------------------------------------------------------------ */
  /* プロジェクト・フェーズ・質問ガイド                                     */
  /* ------------------------------------------------------------------ */

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
    const project = await store.createProject({ orgId, ...input });
    await audit(store, {
      orgId,
      actor: actorOf(c),
      action: "project.create",
      targetType: "project",
      targetId: project.id,
      detail: { name: project.name, confidential: project.confidential, aiConfig: project.aiConfig },
    });
    return c.json(project, 201);
  });

  /** サンプル事例（本システム自身の要求事項）をプロジェクトとして読み込む。AIは呼び出さない */
  app.post("/api/orgs/:orgId/samples", async (c) => {
    const orgId = c.req.param("orgId");
    need(c, orgId, "editor");
    const input = await body(c, z.object({ sample: z.enum(Object.keys(SAMPLES) as [keyof typeof SAMPLES]).default("requirements-navigator") }));
    // プロジェクトのAIの構成は、組織に登録済みのAIから決める（3つ以上: 複数AI＋評価AI、2つ: 複数AI、1つ: 単一AI）
    const creds = (await store.listCredentials(orgId)).filter((x) => x.vendor !== "mock" || deps.allowMock);
    if (!creds.length) throw new HTTPException(400, { message: "先に「AI設定」でAIを登録してください（サンプルの読み込みではAIを呼び出しません）" });
    const ids = creds.map((x) => x.id);
    const aiConfig =
      ids.length >= 2
        ? { mode: "multi" as const, generatorIds: ids.slice(0, 2), evaluatorId: ids[2] ?? null }
        : { mode: "single" as const, generatorIds: ids.slice(0, 1), evaluatorId: null };
    const r = await loadSample(store, { orgId, aiConfig, actor: actorOf(c) });
    await audit(store, {
      orgId,
      actor: actorOf(c),
      action: "project.create",
      targetType: "project",
      targetId: r.project.id,
      detail: { name: r.project.name, sample: input.sample, requirements: r.requirements, documents: r.documents, aiConfig },
    });
    return c.json({ ...r, project: r.project }, 201);
  });

  app.get("/api/projects/:id", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    return c.json({ ...p, phase: PHASES.find((x) => x.key === p.phaseKey) ?? null });
  });

  /** フェーズを移動する（次へ進む・前に戻る・完了にする） */
  app.post("/api/projects/:id/phase", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "editor");
    const { phaseKey } = await body(c, PhaseInput);
    if (phaseKey !== "done") phaseOrThrow(phaseKey);
    await store.setProjectPhase(p.id, phaseKey);
    await audit(store, { orgId: p.orgId, actor: actorOf(c), action: "project.phase", targetType: "project", targetId: p.id, detail: { from: p.phaseKey, to: phaseKey } });
    return c.json({ ...p, phaseKey, phase: PHASES.find((x) => x.key === phaseKey) ?? null });
  });

  app.post("/api/projects/:id/ambiguity", async (c) => {
    await loadProject(c, c.req.param("id"), "viewer");
    const { text } = await body(c, z.object({ text: z.string().max(10_000) }));
    return c.json(detectAmbiguity(text));
  });

  const guideContext = async (p: Project, phase: Phase): Promise<GuideContext> => {
    const reqs = await store.listRequirements(p.id);
    const mine = reqs.filter((r) => phaseOfRequirement(r) === phase.key);
    return {
      phase,
      projectName: p.name,
      projectPurpose: p.purpose,
      phaseRequirements: mine.map((r) => ({ code: r.code, title: r.title })),
      otherRequirements: reqs.filter((r) => !mine.includes(r)).map((r) => ({ code: r.code, title: r.title })),
    };
  };
  const withStale = (g: Guide, ctx: GuideContext) => ({ ...g, stale: g.requirementCount !== ctx.phaseRequirements.length });

  /** 保存済みの質問ガイド（なければAIを使わない既定のもの）。stale=true なら要件が増減している */
  app.get("/api/projects/:id/guide", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    const phase = phaseOrThrow(c.req.query("phaseKey") ?? (p.phaseKey === "done" ? PHASES.at(-1)!.key : p.phaseKey));
    const ctx = await guideContext(p, phase);
    const saved = (await store.latestGuides(p.id)).find((g) => g.phaseKey === phase.key);
    return c.json(saved ? withStale(saved, ctx) : { ...defaultGuide(ctx), stale: true });
  });

  /** AIが観点の網羅状況を判定し、次の質問・回答候補・用語解説を作る */
  app.post("/api/projects/:id/guide", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "editor");
    const input = await body(c, GuideInput);
    const phase = phaseOrThrow(input.phaseKey ?? (p.phaseKey === "done" ? PHASES.at(-1)!.key : p.phaseKey));
    const ctx = await guideContext(p, phase);
    // 質問づくりは軽い処理なので、生成AI → 評価AI の順に1つずつ試す
    const ids = [...new Set([...p.aiConfig.generatorIds, ...(p.aiConfig.evaluatorId ? [p.aiConfig.evaluatorId] : [])])];
    const b = await budget(p.orgId, ids);
    const providers = (await providersOf(p.orgId, ids.filter((id) => !b.excluded.has(id)))).filter((x) => !p.confidential || x.isLocal);
    const r = await generateGuide(providers, ctx, Math.min(deps.timeoutMs ?? 60_000, 60_000));
    if (r.usage && r.guide.providerId) await store.addUsage({ orgId: p.orgId, providerId: r.guide.providerId, projectId: p.id, ...usageOf(r.usage) });
    await store.saveGuide(p.id, r.guide);
    await audit(store, {
      orgId: p.orgId,
      actor: actorOf(c),
      action: "ai.guide",
      targetType: "project",
      targetId: p.id,
      detail: {
        phase: phase.key,
        provider: r.guide.providerId,
        source: r.guide.source,
        tokens: r.usage ? usageOf(r.usage) : null,
        failures: r.failures,
        sent: { requirements: ctx.phaseRequirements.length + ctx.otherRequirements.length },
      },
    });
    return c.json({ ...withStale(r.guide, ctx), warnings: b.warnings, failures: r.failures.length }, 201);
  });

  /** 全フェーズの観点の網羅状況 */
  app.get("/api/projects/:id/coverage", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    const guides = await store.latestGuides(p.id);
    const phases = PHASES.map((ph) => {
      const g = guides.find((x) => x.phaseKey === ph.key);
      return {
        key: ph.key,
        name: ph.name,
        checklist: ph.checklist,
        covered: g?.covered ?? [],
        missing: g?.missing ?? ph.checklist,
        coverage: g?.coverage ?? 0,
        checked: Boolean(g),
      };
    });
    const total = phases.reduce((a, x) => a + x.checklist.length, 0);
    const done = phases.reduce((a, x) => a + x.covered.length, 0);
    return c.json({ overall: total ? done / total : 0, phases });
  });

  /* ------------------------------------------------------------------ */
  /* 生成ラウンド: 並列生成 → 匿名化 → 評価（同期 / 非同期）               */
  /* ------------------------------------------------------------------ */

  async function executeRound(project: Project, input: z.infer<typeof RoundInput>, actor: string, report?: (p: JobProgress) => Promise<void>) {
    if (project.phaseKey === "done" && !input.phaseKey) throw new HTTPException(400, { message: "すべてのフェーズが完了しています" });
    const phase = phaseOrThrow(input.phaseKey ?? project.phaseKey);

    // 今月の上限: 組織の上限なら停止、AI個別の上限ならそのAIを外して続行
    const evaluatorId = project.aiConfig.mode === "multi" ? project.aiConfig.evaluatorId : null;
    const b = await budget(project.orgId, [...project.aiConfig.generatorIds, ...(evaluatorId ? [evaluatorId] : [])]);
    const generatorIds = project.aiConfig.generatorIds.filter((id) => !b.excluded.has(id));
    if (!generatorIds.length) throw new HTTPException(429, { message: `生成AIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const useEvaluator = evaluatorId && !b.excluded.has(evaluatorId) ? evaluatorId : null;
    if (evaluatorId && !useEvaluator) b.warnings.push("評価AIが使えないため、今回は評価なしで案を表示します。");
    const generators = await providersOf(project.orgId, generatorIds);
    const evaluator = useEvaluator ? (await providersOf(project.orgId, [useEvaluator]))[0] : undefined;
    const labels = await labelsOf(project.orgId);
    const tracker = progressTracker(labels, generatorIds, useEvaluator, report);

    const existing = await store.listRequirements(project.id);
    let result: Awaited<ReturnType<typeof runRound>>;
    try {
      result = await runRound(
      {
        phase,
        projectName: project.name,
        projectPurpose: project.purpose,
        existingRequirements: existing.map((r) => ({ ...r, code: r.code, ears: r.ears ?? undefined, rule: r.rule ?? undefined })),
        userAnswer: input.answer,
      },
      {
        generators,
        evaluator,
        confidential: project.confidential,
        timeoutMs: deps.timeoutMs,
        random: deps.random,
        onProgress: tracker.onProgress,
      },
    );
    } finally {
      // 失敗しても、どのAIで止まったかを進み具合に残す
      await tracker.flush();
    }
    result.warnings.unshift(...b.warnings);

    for (const cand of result.candidates)
      await store.addUsage({ orgId: project.orgId, providerId: cand.providerId, projectId: project.id, ...usageOf(cand.usage) });
    if (result.evaluation)
      await store.addUsage({ orgId: project.orgId, providerId: result.evaluation.evaluatorId, projectId: project.id, ...usageOf(result.evaluation.usage) });

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

    await audit(store, {
      orgId: project.orgId,
      actor,
      action: "ai.round",
      targetType: "round",
      targetId: round.id,
      detail: {
        projectId: project.id,
        phase: phase.key,
        // AIに送った内容: 利用者の回答（全文、長い場合は先頭）と、文脈として送った確定済み要件の件数
        sent: { answer: clip(input.answer), contextRequirements: existing.length },
        generators: result.candidates.map((x) => ({ id: x.providerId, label: labels.get(x.providerId), tokens: usageOf(x.usage) })),
        evaluator: result.evaluation
          ? { id: result.evaluation.evaluatorId, label: labels.get(result.evaluation.evaluatorId), tokens: usageOf(result.evaluation.usage) }
          : null,
        failures: result.failures.map((f) => ({ id: f.providerId, label: labels.get(f.providerId), reason: f.reason })),
      },
    });

    // 決定前は、どの案がどのAIのものかを返さない
    const ev = result.evaluation;
    return {
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
      failures: result.failures.map((f) => ({ provider: labels.get(f.providerId) ?? f.providerId, reason: f.reason })),
      warnings: result.warnings,
      ambiguity: detectAmbiguity(input.answer),
    };
  }

  /* ------------------------------------------------------------------ */
  /* UML（単一AI: そのまま採用 / 複数AI: 匿名で比較して選ぶ）               */
  /* ------------------------------------------------------------------ */

  const reqsForUml = async (p: Project) => (await store.listRequirements(p.id)).map((r) => ({ code: r.code, type: r.type, title: r.title }));
  const diagramsOf = async (p: Project) => {
    const reqs = await reqsForUml(p);
    const rec = await store.latestUmlModel(p.id);
    const screens = await store.latestScreens(p.id);
    const diagrams = buildDiagrams(p.name, reqs, rec?.model);
    if (screens) diagrams.push(screenFlowDiagram(screens.model));
    diagrams.push(...(await disc.specMore(p)).diagrams);
    return { diagrams, rec, reqs };
  };
  const umlStats = (m: UmlModel) => ({
    classes: m.classes.length,
    relations: m.relations.length,
    sequences: m.sequences.length,
    stateMachines: m.stateMachines.length,
    activities: m.activities.length,
  });

  async function executeUml(p: Project, actor: string, report?: (pr: JobProgress) => Promise<void>) {
    const reqs = await reqsForUml(p);
    if (!reqs.length) throw new HTTPException(400, { message: "要件がまだありません。ヒアリングで要件を確定してから生成してください" });
    const evaluatorId = p.aiConfig.mode === "multi" ? p.aiConfig.evaluatorId : null;
    const ids = [...new Set([...p.aiConfig.generatorIds, ...(p.aiConfig.evaluatorId ? [p.aiConfig.evaluatorId] : [])])];
    const b = await budget(p.orgId, ids);
    const usable = ids.filter((id) => !b.excluded.has(id));
    if (!usable.length) throw new HTTPException(429, { message: `使えるAIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const labels = await labelsOf(p.orgId);
    const gens = p.aiConfig.generatorIds.filter((id) => !b.excluded.has(id));
    if (p.confidential) {
      const all = await providersOf(p.orgId, usable);
      if (all.some((x) => !x.isLocal)) throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    }

    // 複数AIモードで生成AIが2つ以上使えるときは、比較して利用者が選ぶ
    if (p.aiConfig.mode === "multi" && gens.length >= 2) {
      const useEvaluator = evaluatorId && !b.excluded.has(evaluatorId) ? evaluatorId : null;
      if (evaluatorId && !useEvaluator) b.warnings.push("評価AIが使えないため、今回は評価なしで案を表示します。");
      const tracker = progressTracker(labels, gens, useEvaluator, report);
      let cmp: Awaited<ReturnType<typeof compareUmlModels>>;
      try {
        cmp = await compareUmlModels(
          await providersOf(p.orgId, gens),
          useEvaluator ? (await providersOf(p.orgId, [useEvaluator]))[0] : undefined,
          p.name,
          p.purpose,
          reqs,
          { timeoutMs: deps.timeoutMs, random: deps.random, onProgress: tracker.onProgress },
        );
      } catch (e) {
        throw new HTTPException(502, { message: (e as Error).message });
      } finally {
        await tracker.flush();
      }
      for (const cand of cmp.candidates) await store.addUsage({ orgId: p.orgId, providerId: cand.providerId, projectId: p.id, ...usageOf(cand.usage) });
      if (cmp.evaluation) await store.addUsage({ orgId: p.orgId, providerId: cmp.evaluation.evaluatorId, projectId: p.id, ...usageOf(cmp.evaluation.usage) });
      const warnings = [...b.warnings, ...cmp.warnings];
      const round = await store.saveUmlRound({
        projectId: p.id,
        candidates: cmp.candidates.map((x) => ({ label: x.label, providerId: x.providerId, model: x.model, dropped: x.dropped })),
        evaluation: cmp.evaluation,
        failures: cmp.failures,
        warnings,
      });
      await audit(store, {
        orgId: p.orgId,
        actor,
        action: "ai.uml",
        targetType: "uml_round",
        targetId: round.id,
        detail: {
          projectId: p.id,
          mode: "compare",
          sent: { requirements: reqs.length },
          generators: cmp.candidates.map((x) => ({ id: x.providerId, label: labels.get(x.providerId), tokens: usageOf(x.usage) })),
          evaluator: cmp.evaluation ? { id: cmp.evaluation.evaluatorId, label: labels.get(cmp.evaluation.evaluatorId), tokens: usageOf(cmp.evaluation.usage) } : null,
          failures: cmp.failures.map((f) => ({ id: f.providerId, label: labels.get(f.providerId), reason: f.reason })),
        },
      });
      const ev = cmp.evaluation;
      // 決定前は、どの案がどのAIのものかを返さない
      return {
        mode: "compare" as const,
        umlRoundId: round.id,
        candidates: cmp.candidates.map((x) => ({ label: x.label, diagrams: buildDiagrams(p.name, reqs, x.model), stats: umlStats(x.model), dropped: x.dropped })),
        evaluation: ev
          ? {
              evaluator: labels.get(ev.evaluatorId),
              scores: ev.scores,
              totals: ev.totals,
              comments: ev.comments,
              recommendedLabel: ev.recommendedLabel,
              recommendation: ev.recommendation,
            }
          : null,
        failures: cmp.failures.map((f) => ({ provider: labels.get(f.providerId) ?? f.providerId, reason: f.reason })),
        warnings,
      };
    }

    // 単一AIモード: 生成AI → 評価AI の順に試し、最初に成功したものを採用する
    const providers = await providersOf(p.orgId, usable);
    const tracker = progressTracker(labels, usable.slice(0, 1), null, report);
    tracker.onProgress({ type: "generator", providerId: usable[0]!, status: "running" });
    let result: Awaited<ReturnType<typeof generateUmlModel>>;
    try {
      result = await generateUmlModel(providers, p.name, p.purpose, reqs, deps.timeoutMs);
    } catch (e) {
      throw new HTTPException(502, { message: (e as Error).message });
    }
    tracker.onProgress({ type: "generator", providerId: usable[0]!, status: "done" });
    await tracker.flush();
    await store.addUsage({ orgId: p.orgId, providerId: result.providerId, projectId: p.id, ...usageOf(result.usage) });
    const rec = await store.saveUmlModel(p.id, result.model, result.providerId);
    await audit(store, {
      orgId: p.orgId,
      actor,
      action: "ai.uml",
      targetType: "project",
      targetId: p.id,
      detail: {
        mode: "single",
        sent: { requirements: reqs.length },
        generators: [{ id: result.providerId, label: labels.get(result.providerId), tokens: usageOf(result.usage) }],
        failures: result.failures.map((f) => ({ id: f.providerId, label: labels.get(f.providerId), reason: f.reason })),
      },
    });
    return {
      mode: "adopted" as const,
      diagrams: buildDiagrams(p.name, reqs, rec.model),
      model: { providerId: rec.providerId, provider: labels.get(result.providerId) ?? result.providerId, createdAt: rec.createdAt },
      dropped: result.dropped,
      failures: result.failures,
      warnings: b.warnings,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 非同期ジョブ                                                         */
  /* ------------------------------------------------------------------ */

  const moduleCtx: ImplementationContext = {
    store,
    encryptor: deps.encryptor,
    fetchImpl: deps.fetchImpl ?? fetch,
    timeoutMs: deps.timeoutMs,
    need,
    loadProject,
    actorOf,
    body,
    parseOrThrow,
    budget,
    providersOf,
    labelsOf,
    emit: (orgId, event, data) => cn.emit(orgId, event, data),
  };
  const impl = implementation(moduleCtx);
  const nfr = nfrSheet(moduleCtx);
  const dc = designAndChange(moduleCtx, { gate: nfr.gate, approvalGate: (p) => sc.approvalGate(p) });
  const disc = discovery(moduleCtx);
  const ho = handoff(moduleCtx, { scope: () => sc });
  const sc = scope(moduleCtx, { testsOf: (p) => ho.tests(p), statusOf: (p) => cn.status(p) });
  const cn = connect(moduleCtx, ho, {
    scope: () => sc,
    authenticate: deps.authenticate,
    encryptor: deps.encryptor,
    publicUrl: deps.publicUrl,
    allowPrivateWebhooks: deps.webhookAllowPrivate,
    lookup: deps.webhookLookup,
  });

  const asJobError = (e: unknown): never => {
    if (e instanceof HTTPException) throw new JobError(e.message, e.status);
    if (e instanceof RoundError) throw new JobError(e.message, e.code === "all_failed" ? 502 : 400);
    throw e;
  };
  const runner = new JobRunner(
    store,
    {
      round: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return executeRound(p, parseOrThrow(RoundInput, job.input), job.createdBy, report).catch(asJobError);
      },
      uml: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return executeUml(p, job.createdBy, report).catch(asJobError);
      },
      tasks: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return impl.jobHandlers.tasks(p, job.input, job.createdBy, report).catch(asJobError);
      },
      export: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return impl.jobHandlers.export(p, job.input, job.createdBy, report).catch(asJobError);
      },
      screens: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return dc.jobHandlers.screens(p, job.input, job.createdBy, report).catch(asJobError);
      },
      impact: async ({ job, report }) => dc.jobHandlers.impact(job.input, job.createdBy, report).catch(asJobError),
      nfrReview: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return nfr.reviewJobHandler(p, job.createdBy, report).catch(asJobError);
      },
      nfr: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return nfr.jobHandler(p, job.input, job.createdBy, report).catch(asJobError);
      },
      analysis: async ({ job, report }) => {
        const p = await store.getProject(job.projectId!);
        if (!p) throw new JobError("プロジェクトが見つかりません", 404);
        return disc.jobHandler(p, job.input, job.createdBy, report).catch(asJobError);
      },
    },
    deps.jobs,
  );
  if (deps.runJobs !== false) runner.start();

  const enqueue = async (c: Context<Env>, p: Project, kind: Job["kind"], input: Record<string, unknown>) => {
    const job = await store.createJob({ orgId: p.orgId, projectId: p.id, kind, input, createdBy: actorOf(c) });
    runner.kick();
    return c.json({ jobId: job.id, status: job.status }, 202);
  };
  const wantsAsync = (c: Context) => c.req.query("async") === "1" || c.req.query("async") === "true";
  impl.routes(app, { wantsAsync, enqueue });
  dc.routes(app, { wantsAsync, enqueue });
  disc.routes(app, { wantsAsync, enqueue });
  nfr.routes(app, { wantsAsync, enqueue });
  ho.routes(app);
  sc.routes(app);
  cn.routes(app);

  /** EARS の構造から文を組み立て、検査結果を返す（画面の入力中の確認用） */
  app.post("/api/ears/preview", async (c) => {
    const { ears, type } = await body(c, z.object({ ears: Ears, type: z.string().default("FR") }));
    const text = renderEars(ears);
    return c.json({ text, lint: lintEars(text, type) });
  });

  /** 確定後は要件を直接変えられない（変更要求で行う） */
  const assertNotBaselined = async (p: Project) => {
    const b = await dc.baselineOf(p.id);
    if (b) {
      throw new HTTPException(409, {
        message: `要件定義は確定済みです（確定版 v${b.version}）。「変更管理」で変更要求として登録し、影響を確認してから変更してください`,
      });
    }
  };

  app.get("/api/jobs/:id", async (c) => {
    const job = await store.getJob(c.req.param("id"));
    if (!job) throw new HTTPException(404, { message: "見つかりません" });
    need(c, job.orgId, "viewer");
    if (job.createdBy !== actorOf(c) && !hasRole(c.get("principal"), "admin")) throw new HTTPException(404, { message: "見つかりません" });
    return c.json({
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      result: job.status === "done" ? job.result : null,
      error: job.error,
      errorStatus: job.errorStatus,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  });

  /* ------------------------------------------------------------------ */
  /* ルート: 生成・決定・UML                                              */
  /* ------------------------------------------------------------------ */

  app.post("/api/projects/:id/rounds", async (c) => {
    const project = await loadProject(c, c.req.param("id"), "editor");
    const input = await body(c, RoundInput);
    if (wantsAsync(c)) {
      // 受け付け時点で、上限やフェーズの誤りはすぐに返す
      if (project.phaseKey === "done" && !input.phaseKey) throw new HTTPException(400, { message: "すべてのフェーズが完了しています" });
      phaseOrThrow(input.phaseKey ?? project.phaseKey);
      await budget(project.orgId, []);
      return enqueue(c, project, "round", input);
    }
    return c.json(await executeRound(project, input, actorOf(c)), 201);
  });

  app.post("/api/rounds/:id/decision", async (c) => {
    const round = await store.getRound(c.req.param("id"));
    if (!round) throw new HTTPException(404, { message: "見つかりません" });
    const project = await loadProject(c, round.projectId, "editor");
    if (round.status === "decided") throw new HTTPException(409, { message: "このラウンドは決定済みです" });
    const input = await body(c, DecisionInput);

    const content = input.pick === "merged" ? round.evaluation?.merged : round.candidates.find((x) => x.label === input.pick)?.content;
    if (!content) throw new HTTPException(400, { message: `選択肢がありません: ${input.pick}` });
    const picked: RequirementItem[] = input.itemIndexes
      ? input.itemIndexes.map((i) => {
          const it = content.items[i];
          if (!it) throw new HTTPException(400, { message: `項目番号が範囲外です: ${i}` });
          return it;
        })
      : content.items;
    if (!picked.length) throw new HTTPException(400, { message: "採用する項目を1つ以上選んでください" });

    const labels = await labelsOf(project.orgId);
    const mapping = Object.fromEntries(round.candidates.map((x) => [x.label, labels.get(x.providerId) ?? x.providerId]));
    const pickName = input.pick === "merged" ? "統合案" : `案${input.pick}`;

    // 確定後のヒアリングで採用した項目は、要件に直接加えず「追加」の変更要求にする
    if (await dc.baselineOf(project.id)) {
      const changeRequests = [];
      for (const it of picked) {
        changeRequests.push(
          await store.addChangeRequest({
            projectId: project.id,
            kind: "add",
            requirementId: null,
            requirementCode: null,
            proposal: { title: it.title, description: it.description, priority: it.priority, type: it.type },
            reason: `ヒアリングで${pickName}を採用${input.reason ? `：${input.reason}` : ""}`,
            source: "hearing",
            createdBy: actorOf(c),
          }),
        );
      }
      const decision = await store.addDecision({ projectId: project.id, roundId: round.id, pick: pickName, reason: input.reason, mapping });
      await store.markRoundDecided(round.id);
      await audit(store, {
        orgId: project.orgId,
        actor: actorOf(c),
        action: "decision.create",
        targetType: "round",
        targetId: round.id,
        detail: { projectId: project.id, pick: pickName, reason: input.reason, mapping, changeRequests: changeRequests.map((x) => x.code) },
      });
      return c.json({ added: [], changeRequests, decision, mapping, nextPhase: project.phaseKey }, 201);
    }

    const added = await store.addRequirements(
      project.id,
      picked.map((it) => ({ ...it, roundId: round.id, source: pickName, phaseKey: round.phaseKey })),
    );
    const decision = await store.addDecision({ projectId: project.id, roundId: round.id, pick: pickName, reason: input.reason, mapping });
    await store.markRoundDecided(round.id);

    let nextPhase: string | null = project.phaseKey;
    if (input.advancePhase && round.phaseKey === project.phaseKey) {
      nextPhase = nextPhaseKey(project.phaseKey);
      await store.setProjectPhase(project.id, nextPhase);
    }
    await audit(store, {
      orgId: project.orgId,
      actor: actorOf(c),
      action: "decision.create",
      targetType: "round",
      targetId: round.id,
      detail: { projectId: project.id, pick: pickName, reason: input.reason, mapping, added: added.map((r) => r.code) },
    });
    return c.json({ added, decision, mapping, nextPhase }, 201);
  });

  app.get("/api/projects/:id/uml", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    const { diagrams, rec } = await diagramsOf(p);
    const labels = await labelsOf(p.orgId);
    return c.json({
      diagrams,
      model: rec ? { providerId: rec.providerId, provider: labels.get(rec.providerId) ?? null, createdAt: rec.createdAt } : null,
    });
  });

  /** AIが要件から設計モデル（クラス・シーケンス・状態・アクティビティ）を作る */
  app.post("/api/projects/:id/uml/generate", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "editor");
    if (wantsAsync(c)) {
      if (!(await reqsForUml(p)).length) throw new HTTPException(400, { message: "要件がまだありません。ヒアリングで要件を確定してから生成してください" });
      await budget(p.orgId, []);
      return enqueue(c, p, "uml", {});
    }
    return c.json(await executeUml(p, actorOf(c)), 201);
  });

  /** 複数AIで比較したUMLの案から1つを採用する */
  app.post("/api/uml-rounds/:id/adopt", async (c) => {
    const round = await store.getUmlRound(c.req.param("id"));
    if (!round) throw new HTTPException(404, { message: "見つかりません" });
    const p = await loadProject(c, round.projectId, "editor");
    if (round.status === "decided") throw new HTTPException(409, { message: "この比較は決定済みです" });
    const input = await body(c, UmlAdoptInput);
    const cand = round.candidates.find((x) => x.label === input.label);
    if (!cand) throw new HTTPException(400, { message: `選択肢がありません: ${input.label}` });
    const rec = await store.saveUmlModel(p.id, cand.model, cand.providerId);
    await store.markUmlRoundDecided(round.id);
    const labels = await labelsOf(p.orgId);
    const mapping = Object.fromEntries(round.candidates.map((x) => [x.label, labels.get(x.providerId) ?? x.providerId]));
    await audit(store, {
      orgId: p.orgId,
      actor: actorOf(c),
      action: "uml.adopt",
      targetType: "uml_round",
      targetId: round.id,
      detail: { projectId: p.id, pick: `案${cand.label}`, reason: input.reason, mapping },
    });
    return c.json(
      {
        diagrams: buildDiagrams(p.name, await reqsForUml(p), rec.model),
        model: { providerId: rec.providerId, provider: mapping[cand.label], createdAt: rec.createdAt },
        mapping,
      },
      201,
    );
  });

  /* ------------------------------------------------------------------ */
  /* 要件の参照・手直し                                                   */
  /* ------------------------------------------------------------------ */

  app.get("/api/projects/:id/requirements", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    // 機能要件・非機能要件は EARS の文型と表現を検査した結果を付ける
    return c.json((await store.listRequirements(p.id)).map((r) => ({ ...r, lint: lintOf(r) })));
  });

  /** 要件の手直し。変更前の内容は版として残る */
  app.patch("/api/requirements/:id", async (c) => {
    const { r, p } = await loadRequirement(c, c.req.param("id"), "editor");
    await assertNotBaselined(p);
    const input = await body(c, RequirementPatchInput);
    const { reason, ...patch } = input;
    if (!Object.values(patch).some((v) => v !== undefined)) throw new HTTPException(400, { message: "変更する項目がありません" });
    if (patch.ears && EARS_TYPES.includes(r.type)) patch.title = renderEars(patch.ears);
    else if (patch.ears) patch.ears = undefined; // 目的・利用者・制約は EARS の対象外
    else if (patch.title !== undefined && patch.title !== r.title && patch.ears === undefined) patch.ears = null; // 文を手で変えたら構造は外す
    if (patch.rule !== undefined && r.type !== "RL") patch.rule = undefined; // 具体例は業務ルールだけ
    const updated = await store.updateRequirement(r.id, patch, actorOf(c), reason);
    if (!updated) throw new HTTPException(404, { message: "要件が見つかりません" });
    await audit(store, {
      orgId: p.orgId,
      actor: actorOf(c),
      action: "requirement.update",
      targetType: "requirement",
      targetId: r.id,
      detail: {
        code: r.code,
        reason,
        before: { title: r.title, description: r.description, priority: r.priority },
        after: { title: updated.title, description: updated.description, priority: updated.priority },
        version: updated.version,
      },
    });
    return c.json(updated);
  });

  /** 要件の削除（論理削除。番号は再利用しない） */
  app.delete("/api/requirements/:id", async (c) => {
    const { r, p } = await loadRequirement(c, c.req.param("id"), "editor");
    await assertNotBaselined(p);
    await store.deleteRequirement(r.id);
    await audit(store, {
      orgId: p.orgId,
      actor: actorOf(c),
      action: "requirement.delete",
      targetType: "requirement",
      targetId: r.id,
      detail: { code: r.code, title: r.title, reason: c.req.query("reason") ?? "" },
    });
    return c.body(null, 204);
  });

  app.get("/api/requirements/:id/versions", async (c) => {
    const { r } = await loadRequirement(c, c.req.param("id"), "viewer");
    return c.json({ current: r, history: await store.listRequirementVersions(r.id) });
  });

  app.get("/api/projects/:id/decisions", async (c) => {
    const p = await loadProject(c, c.req.param("id"), "viewer");
    return c.json(await store.listDecisions(p.id));
  });

  /* ------------------------------------------------------------------ */
  /* 仕様書（Markdown / Word / PDF）                                       */
  /* ------------------------------------------------------------------ */

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
    const more = await dc.specMore(p);
    const found = await disc.specMore(p);
    const spec = buildSpec(p, await store.listRequirements(p.id), await store.listDecisions(p.id), diagrams, new Date(), {
      baseline: more.baseline,
      extras: [...more.extras, ...found.extras, ...(await nfr.specMore(p)), ...(await sc.specMore(p)), ...(await ho.specMore(p))],
    });
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
    const input = await body(c, ExportInput);
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
    await audit(store, {
      orgId: p.orgId,
      actor: actorOf(c),
      action: "spec.export",
      targetType: "project",
      targetId: p.id,
      detail: { format: input.format, images: images.length, bytes: buf.length, key: key ?? null },
    });
    return fileResponse(c, p, input.format, buf, key);
  });

  return Object.assign(app, { jobs: runner, connect: cn });
}
