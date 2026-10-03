/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AI の API キーの自動発行と、キーの確認（モデル一覧の取得）。
 *
 * 提供元が公式に用意している方法だけを使う。
 * - Claude: 外部から発行する仕組みがない（Claude Console でのみ発行）。貼り付けたキーの確認とモデル一覧の取得だけ
 * - ChatGPT（OpenAI）: 管理用キー（Admin key）で、プロジェクトに要件ナビ専用のサービスアカウントを作り、そのキーを登録する。
 *   管理用キーは保存しない（この処理の間だけ使う）
 * - Gemini: Google でログイン（OAuth 2.0 認可コード + PKCE）し、Google Cloud のプロジェクトで Gemini API を有効にして、
 *   Gemini API だけに使えるキーを作って登録する。Google のアクセストークンは保存しない（暗号化して画面に渡し、1時間以内だけ使える）
 *
 * どの経路でも、発行したキーは画面に返さず、暗号化して保存する（表示は末尾4桁）。
 */
import { createHash, randomBytes } from "node:crypto";
import { checkApiKey, guessKeyVendor, KeyCheckError, keyCheckMessage, listModels, redactSecrets, VENDOR_INFO, type FetchLike, type Vendor } from "@arn/ai-core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { KeyEncryptor } from "./crypto.js";
import type { ImplementationContext } from "./implementation.js";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface KeySetupOptions {
  /** AI を登録する（app.ts の registerCredential）。via は監査ログに残す発行の記録 */
  register: (
    c: Context,
    orgId: string,
    input: { vendor: Vendor; model: string; label?: string; apiKey?: string; endpoint?: string; monthlyTokenLimit?: number | null },
    via?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  google?: GoogleOAuthConfig;
  publicUrl?: string;
  /** 長く掛かる処理（Google の API の有効化など）の確認間隔（テスト用） */
  pollMs?: number;
}

const OPENAI = "https://api.openai.com";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GEMINI_SERVICE = "generativelanguage.googleapis.com";

const VendorSchema = z.enum(["anthropic", "openai", "gemini", "ollama", "mock"]);
const CheckInput = z.object({ vendor: VendorSchema, apiKey: z.string().max(500).optional(), endpoint: z.string().url().optional() });
const Common = {
  model: z.string().min(1).max(200),
  label: z.string().max(100).optional(),
  monthlyTokenLimit: z.number().int().positive().nullable().optional(),
};
const OpenAIProjectsInput = z.object({ adminKey: z.string().min(1).max(500) });
const OpenAIIssueInput = z.object({
  adminKey: z.string().min(1).max(500),
  /** 既存のプロジェクト。省略すると projectName で新しく作る */
  projectId: z.string().regex(/^proj_[A-Za-z0-9]+$/).optional(),
  projectName: z.string().min(1).max(100).optional(),
  /** 発行するキーの有効期限（日）。組織の方針で期限が必須の場合に指定 */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  ...Common,
});
const GoogleProjectsInput = z.object({ session: z.string().min(10).max(8000) });
const GoogleIssueInput = z.object({
  session: z.string().min(10).max(8000),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "プロジェクトIDの形式が正しくありません"),
  ...Common,
});

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

/** 暗号化した短期の値（状態・セッション）。組織IDで束縛し、期限と利用者を確かめる */
async function seal(enc: KeyEncryptor, orgId: string, data: Record<string, unknown>): Promise<string> {
  return `${orgId}.${b64url(await enc.encrypt(JSON.stringify(data), { orgId }))}`;
}
async function unseal(enc: KeyEncryptor, sealed: string, now: number): Promise<{ orgId: string; data: any }> {
  const i = sealed.indexOf(".");
  if (i <= 0) throw new HTTPException(400, { message: "Google のログインの情報が正しくありません。もう一度ログインしてください" });
  const orgId = sealed.slice(0, i);
  let data: any;
  try {
    data = JSON.parse(await enc.decrypt(unb64url(sealed.slice(i + 1)), { orgId }));
  } catch {
    throw new HTTPException(400, { message: "Google のログインの情報が正しくありません。もう一度ログインしてください" });
  }
  if (typeof data?.e !== "number" || data.e < now) throw new HTTPException(400, { message: "Google のログインの有効期限が切れました。もう一度ログインしてください" });
  return { orgId, data };
}

export function keySetup(ctx: ImplementationContext, opts: KeySetupOptions) {
  const { store } = ctx;
  const fetchImpl: FetchLike = ctx.fetchImpl;
  const pollMs = opts.pollMs ?? 1000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 共通: JSON の呼び出し（エラー文からキーやトークンを伏せる） ---------- */
  async function call(url: string, init: RequestInit, onError: (status: number, detail: string) => HTTPException): Promise<any> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new HTTPException(502, { message: `接続できませんでした（${new URL(url).host}）: ${redactSecrets((e as Error).message).slice(0, 120)}` });
    }
    const text = await res.text();
    let j: any = null;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      /* JSON でない */
    }
    if (!res.ok) {
      const d = j?.error?.message ?? j?.message ?? "";
      throw onError(res.status, redactSecrets(typeof d === "string" ? d : "").slice(0, 300));
    }
    if (j === null) throw new HTTPException(502, { message: `応答がJSONではありません（${new URL(url).host}）` });
    return j;
  }

  /* ---------- キーの確認とモデル一覧 ---------- */
  const checkResult = async (vendor: Vendor, cfg: { apiKey?: string | null; endpoint?: string | null }) => {
    try {
      const models = await listModels(vendor, cfg, fetchImpl, AbortSignal.timeout(20_000));
      return { ok: true as const, models };
    } catch (e) {
      if (e instanceof KeyCheckError) return { ok: false as const, reason: e.reason, message: e.message };
      return { ok: false as const, reason: "other" as const, message: redactSecrets((e as Error).message).slice(0, 200) };
    }
  };
  /** 別名（例: 日付なしのモデル名）でも見つかったことにする */
  const modelFound = (models: Array<{ id: string }>, model: string) => models.some((m) => m.id === model || m.id.startsWith(`${model}-`));

  /* ---------- ChatGPT（OpenAI）: 管理用キーでサービスアカウントのキーを発行 ---------- */
  function adminKeyOrThrow(raw: string): string {
    const key = raw.trim().replace(/^(["'])(.*)\1$/, "$2").replace(/^Bearer\s+/i, "").trim();
    if (!key || /\s/.test(key) || !/^[\x21-\x7e]+$/.test(key)) throw new HTTPException(400, { message: "管理用キーに空白や全角文字が入っています。キーだけを貼り付けてください" });
    const g = guessKeyVendor(key);
    if (g && g !== "openai") throw new HTTPException(400, { message: `これは ${VENDOR_INFO[g].name} のキーです。OpenAI の管理用キー（sk-admin- で始まる）を入れてください` });
    if (key.startsWith("sk-") && !key.startsWith("sk-admin-")) {
      throw new HTTPException(400, { message: "これは通常の API キーです。そのまま使う場合は「キーを貼り付け」で登録してください。自動で発行する場合は、管理用キー（sk-admin- で始まる）を入れてください" });
    }
    return key;
  }
  const openaiError = (status: number, detail: string) => {
    if (status === 401) return new HTTPException(400, { message: "OpenAI の管理用キーが正しくないか、無効になっています" });
    if (status === 403) return new HTTPException(400, { message: "OpenAI の管理用キーに、プロジェクトとサービスアカウントを管理する権限がありません。権限を付けて管理用キーを作り直してください" });
    return new HTTPException(502, { message: `OpenAI から HTTP ${status} が返りました${detail ? `：${detail}` : ""}` });
  };
  const openai = (adminKey: string, path: string, init: RequestInit = {}) =>
    call(`${OPENAI}/v1${path}`, { ...init, headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } }, openaiError);

  async function openaiProjects(adminKey: string) {
    const out: Array<{ id: string; name: string }> = [];
    let after = "";
    for (let page = 0; page < 10; page++) {
      const j = await openai(adminKey, `/organization/projects?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      for (const p of j.data ?? []) if (p.status !== "archived") out.push({ id: String(p.id), name: String(p.name ?? p.id) });
      if (!j.has_more || !j.last_id) break;
      after = j.last_id;
    }
    return out;
  }

  /* ---------- Gemini: Google でログインして、Gemini API 専用のキーを作る ---------- */
  const googleError = (what: string) => (status: number, detail: string) => {
    if (status === 401) return new HTTPException(400, { message: "Google のログインの有効期限が切れたか、取り消されました。もう一度ログインしてください" });
    if (status === 403) {
      const hint = /has not been used|is disabled|SERVICE_DISABLED/i.test(detail)
        ? "（要件ナビの管理者が、OAuth クライアントのプロジェクトで「Cloud Resource Manager API」「Service Usage API」「API Keys API」を有効にしてください。docs/ai-keys.md）"
        : "（そのプロジェクトのオーナーか編集者のアカウントでログインしてください）";
      return new HTTPException(400, { message: `Google Cloud で${what}の権限がありません${hint}${detail ? `：${detail}` : ""}` });
    }
    return new HTTPException(502, { message: `Google Cloud で${what}に失敗しました（HTTP ${status}）${detail ? `：${detail}` : ""}` });
  };
  const google = (token: string, url: string, what: string, init: RequestInit = {}) =>
    call(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } }, googleError(what));

  /** 長く掛かる処理（Operation）の完了を待つ */
  async function waitOperation(token: string, base: string, op: any, what: string) {
    let cur = op;
    for (let i = 0; i < 60 && !cur?.done; i++) {
      // 応答の名前は URL に使うため、形を確かめる
      if (!/^operations\/[A-Za-z0-9._\-]+$/.test(String(cur?.name ?? ""))) throw new HTTPException(502, { message: `Google Cloud で${what}の状態を確かめられませんでした` });
      await sleep(pollMs);
      cur = await google(token, `${base}/${cur.name}`, what);
    }
    if (!cur?.done) throw new HTTPException(504, { message: `Google Cloud で${what}が終わりませんでした。しばらくしてからもう一度試してください` });
    if (cur.error) throw new HTTPException(502, { message: `Google Cloud で${what}に失敗しました：${redactSecrets(String(cur.error.message ?? "")).slice(0, 300)}` });
    return cur.response ?? {};
  }

  async function googleSession(c: Context, orgId: string, session: string) {
    const { orgId: o, data } = await unseal(ctx.encryptor, session, Date.now());
    if (o !== orgId || data.k !== "gs" || data.a !== ctx.actorOf(c)) throw new HTTPException(403, { message: "このログインの情報は使えません。もう一度 Google でログインしてください" });
    return String(data.t);
  }

  /** 外から見たURL（PUBLIC_URL。なければリクエストから作り、ロードバランサーの X-Forwarded-Proto を使う） */
  const redirectBase = (c: Context) => {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    const u = new URL(c.req.url);
    const proto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim();
    if (proto === "https" || proto === "http") u.protocol = `${proto}:`;
    return u.origin;
  };

  function routes(app: Hono<any>) {
    /** 登録前: 貼り付けたキーを確かめ、モデル一覧を返す */
    app.post("/api/orgs/:orgId/providers/check", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, CheckInput);
      const info = VENDOR_INFO[input.vendor];
      let apiKey: string | undefined;
      if (info.keyName) {
        if (!input.apiKey) throw new HTTPException(400, { message: `${info.keyName}を入れてください` });
        const k = checkApiKey(input.vendor, input.apiKey, { customEndpoint: Boolean(input.endpoint) });
        if (!k.ok) return c.json({ ok: false, reason: "format", message: k.message });
        apiKey = k.key;
      }
      return c.json(await checkResult(input.vendor, { apiKey, endpoint: input.endpoint ?? info.endpointDefault }));
    });

    /** 登録済み: 保存したキーで接続できるか、モデルIDが一覧にあるかを確かめる */
    app.post("/api/orgs/:orgId/providers/:id/check", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const cr = (await store.listCredentials(orgId)).find((x) => x.id === c.req.param("id"));
      if (!cr) throw new HTTPException(404, { message: "見つかりません" });
      const apiKey = cr.encryptedKey ? await ctx.encryptor.decrypt(cr.encryptedKey, { orgId }) : null;
      const r = await checkResult(cr.vendor, { apiKey, endpoint: cr.endpoint });
      if (!r.ok) return c.json({ ...r, model: cr.model });
      const found = modelFound(r.models, cr.model);
      return c.json({
        ...r,
        model: cr.model,
        modelFound: found,
        message: found
          ? `${VENDOR_INFO[cr.vendor].name} に接続できました（モデル ${cr.model} を確認）`
          : `${VENDOR_INFO[cr.vendor].name} に接続できましたが、モデルID「${cr.model}」が一覧にありません。「変更」で一覧から選び直してください`,
      });
    });

    /* ----- ChatGPT（OpenAI） ----- */
    app.post("/api/orgs/:orgId/providers/auto/openai/projects", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, OpenAIProjectsInput);
      return c.json({ projects: await openaiProjects(adminKeyOrThrow(input.adminKey)) });
    });

    app.post("/api/orgs/:orgId/providers/auto/openai", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, OpenAIIssueInput);
      const adminKey = adminKeyOrThrow(input.adminKey);
      const org = await store.getOrg(orgId);
      let project: { id: string; name: string };
      if (input.projectId) {
        const p = await openai(adminKey, `/organization/projects/${input.projectId}`);
        project = { id: String(p.id), name: String(p.name ?? p.id) };
      } else {
        const p = await openai(adminKey, "/organization/projects", { method: "POST", body: JSON.stringify({ name: input.projectName ?? "要件ナビ" }) });
        project = { id: String(p.id), name: String(p.name ?? input.projectName ?? "要件ナビ") };
      }
      const saName = `要件ナビ ${org?.name ?? orgId}`.slice(0, 60);
      const sa = await openai(adminKey, `/organization/projects/${project.id}/service_accounts`, {
        method: "POST",
        body: JSON.stringify({ name: saName, ...(input.expiresInDays ? { expires_in_seconds: input.expiresInDays * 86400 } : {}) }),
      });
      const key = sa?.api_key?.value;
      if (typeof key !== "string" || !key) throw new HTTPException(502, { message: "OpenAI からキーを受け取れませんでした（サービスアカウントは作られている可能性があります。OpenAI Platform で確認してください）" });
      const via = { by: "openai-admin-key", projectId: project.id, projectName: project.name, serviceAccountId: sa.id, serviceAccountName: sa.name ?? saName, keyId: sa.api_key.id ?? null };
      try {
        const cred = await opts.register(c, orgId, { vendor: "openai", model: input.model, label: input.label, apiKey: key, monthlyTokenLimit: input.monthlyTokenLimit }, via);
        return c.json({ ...cred, issued: via }, 201);
      } catch (e) {
        // 登録できなかったときは、作ったサービスアカウント（とキー）を消して残さない
        await openai(adminKey, `/organization/projects/${project.id}/service_accounts/${sa.id}`, { method: "DELETE" }).catch(() => undefined);
        throw e;
      }
    });

    /* ----- Gemini（Google でログイン） ----- */
    app.get("/api/orgs/:orgId/providers/auto/google/start", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      if (!opts.google) {
        throw new HTTPException(501, { message: "Google でのログインは設定されていません（サーバーの GOOGLE_OAUTH_CLIENT_ID と GOOGLE_OAUTH_CLIENT_SECRET。docs/ai-keys.md）" });
      }
      const verifier = randomBytes(32).toString("base64url");
      const redirectUri = `${redirectBase(c)}/api/oauth/google/callback`;
      const state = await seal(ctx.encryptor, orgId, { k: "gst", a: ctx.actorOf(c), v: verifier, r: redirectUri, e: Date.now() + 10 * 60_000, n: randomBytes(8).toString("hex") });
      const q = new URLSearchParams({
        client_id: opts.google.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPE,
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        access_type: "online",
        include_granted_scopes: "false",
        prompt: "select_account consent",
      });
      return c.json({ url: `${GOOGLE_AUTH}?${q}` });
    });

    /** Google からの戻り先（ブラウザの移動なので、要件ナビのログイン情報は付かない。state で組織と利用者を確かめる） */
    app.get("/api/oauth/google/callback", async (c) => {
      const back = (frag: string, base?: string) => c.redirect(`${base ?? redirectBase(c)}/#${frag}`, 302);
      if (!opts.google) return back(`google-error=${encodeURIComponent("Google でのログインは設定されていません")}`);
      const stateRaw = c.req.query("state") ?? "";
      let st: { orgId: string; data: any };
      try {
        st = await unseal(ctx.encryptor, stateRaw, Date.now());
        if (st.data.k !== "gst") throw new Error("kind");
      } catch {
        return back(`google-error=${encodeURIComponent("ログインの有効期限が切れたか、正しくありません。もう一度試してください")}`);
      }
      const base = new URL(String(st.data.r)).origin;
      const err = c.req.query("error");
      if (err) return back(`google-error=${encodeURIComponent(err === "access_denied" ? "Google でのログインが取り消されました" : `Google でのログインに失敗しました（${err.slice(0, 50)}）`)}`, base);
      const code = c.req.query("code");
      if (!code) return back(`google-error=${encodeURIComponent("Google から認可コードを受け取れませんでした")}`, base);
      let tok: any;
      try {
        tok = await call(
          GOOGLE_TOKEN,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code,
              client_id: opts.google.clientId,
              client_secret: opts.google.clientSecret,
              redirect_uri: String(st.data.r),
              grant_type: "authorization_code",
              code_verifier: String(st.data.v),
            }).toString(),
          },
          (status) => new HTTPException(400, { message: `Google でのログインを完了できませんでした（HTTP ${status}）` }),
        );
      } catch (e) {
        return back(`google-error=${encodeURIComponent((e as Error).message)}`, base);
      }
      if (typeof tok.access_token !== "string" || !String(tok.scope ?? GOOGLE_SCOPE).split(" ").includes(GOOGLE_SCOPE)) {
        return back(`google-error=${encodeURIComponent("Google Cloud を操作する許可が得られませんでした。ログインのときに許可してください")}`, base);
      }
      const ttl = Math.min(Number(tok.expires_in ?? 3600), 3600) * 1000 - 60_000;
      const session = await seal(ctx.encryptor, st.orgId, { k: "gs", a: st.data.a, t: tok.access_token, e: Date.now() + Math.max(ttl, 60_000) });
      return back(`google-session=${encodeURIComponent(session)}`, base);
    });

    app.post("/api/orgs/:orgId/providers/auto/google/projects", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, GoogleProjectsInput);
      const token = await googleSession(c, orgId, input.session);
      const out: Array<{ id: string; name: string }> = [];
      let pageToken = "";
      for (let page = 0; page < 10; page++) {
        const j = await google(
          token,
          `https://cloudresourcemanager.googleapis.com/v1/projects?filter=${encodeURIComponent("lifecycleState:ACTIVE")}&pageSize=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
          "プロジェクトの一覧の取得",
        );
        for (const p of j.projects ?? []) out.push({ id: String(p.projectId), name: String(p.name ?? p.projectId) });
        pageToken = j.nextPageToken ?? "";
        if (!pageToken) break;
      }
      return c.json({ projects: out.sort((a, b) => a.name.localeCompare(b.name, "ja")) });
    });

    app.post("/api/orgs/:orgId/providers/auto/google", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, GoogleIssueInput);
      const token = await googleSession(c, orgId, input.session);
      const org = await store.getOrg(orgId);
      const p = input.projectId;
      // 1) Gemini API を有効にする（有効になっていれば、すぐに終わる）
      const su = "https://serviceusage.googleapis.com/v1";
      const enableOp = await google(token, `${su}/projects/${p}/services:batchEnable`, "Gemini API の有効化", {
        method: "POST",
        body: JSON.stringify({ serviceIds: [GEMINI_SERVICE] }),
      });
      await waitOperation(token, su, enableOp, "Gemini API の有効化");
      // 2) Gemini API だけに使えるキーを作る
      const ak = "https://apikeys.googleapis.com/v2";
      const displayName = `要件ナビ ${org?.name ?? ""}`.trim().slice(0, 63);
      const keyOp = await google(token, `${ak}/projects/${p}/locations/global/keys`, "API キーの作成", {
        method: "POST",
        body: JSON.stringify({ displayName, restrictions: { apiTargets: [{ service: GEMINI_SERVICE }] } }),
      });
      const keyRes = await waitOperation(token, ak, keyOp, "API キーの作成");
      const keyName = String(keyRes.name ?? "");
      if (!/^projects\/[^/]+\/locations\/global\/keys\/[^/]+$/.test(keyName)) throw new HTTPException(502, { message: "Google Cloud から作ったキーの情報を受け取れませんでした" });
      // 3) キーの文字列を受け取る（作成の応答には含まれない）
      const ks = await google(token, `${ak}/${keyName}/keyString`, "API キーの取得");
      const key = ks?.keyString;
      if (typeof key !== "string" || !key) throw new HTTPException(502, { message: "Google Cloud からキーを受け取れませんでした（キーは作られている可能性があります。Google Cloud コンソールの「認証情報」で確認してください）" });
      const via = { by: "google-oauth", projectId: p, keyName, displayName, restrictedTo: GEMINI_SERVICE };
      try {
        const cred = await opts.register(c, orgId, { vendor: "gemini", model: input.model, label: input.label, apiKey: key, monthlyTokenLimit: input.monthlyTokenLimit }, via);
        return c.json({ ...cred, issued: via, notice: "新しいキーは、使えるようになるまで1〜2分かかることがあります" }, 201);
      } catch (e) {
        await google(token, `${ak}/${keyName}`, "API キーの削除", { method: "DELETE" }).catch(() => undefined);
        throw e;
      }
    });
  }

  return { routes, keyCheckMessage };
}
