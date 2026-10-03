import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 提供元の API の代わり（呼ばれた URL・ヘッダーを記録する） */
function fakeProviders() {
  const calls: Array<{ url: string; method: string; auth: string; body: string }> = [];
  const state = { saDeleted: false, keyDeleted: false, failRegister: false, polls: 0 };
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const h = new Headers(init.headers);
    const auth = h.get("authorization") ?? h.get("x-api-key") ?? h.get("x-goog-api-key") ?? "";
    const method = init.method ?? "GET";
    calls.push({ url, method, auth, body: String(init.body ?? "") });
    const u = new URL(url);
    // ---- モデル一覧（キーの確認） ----
    if (u.host === "api.anthropic.com" && u.pathname === "/v1/models") {
      if (auth !== "sk-ant-api03-good") return res(401, { error: { message: "invalid x-api-key" } });
      return res(200, { data: [{ id: "claude-test-4-5-20260101", display_name: "Claude Test 4.5" }, { id: "claude-old-3", display_name: "Claude Old" }], has_more: false });
    }
    if (u.host === "api.openai.com" && u.pathname === "/v1/models") {
      if (!auth.startsWith("Bearer sk-svcacct-")) return res(401, { error: { message: `Incorrect API key provided: ${auth.slice(7, 14)}***` } });
      return res(200, { data: [{ id: "gpt-test-5", created: 3 }, { id: "whisper-1", created: 9 }, { id: "gpt-test-4", created: 2 }, { id: "text-embedding-3", created: 5 }] });
    }
    if (u.host === "generativelanguage.googleapis.com" && u.pathname === "/v1beta/models") {
      return res(200, { models: [{ name: "models/gemini-test-pro", displayName: "Gemini Test Pro", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }] });
    }
    // ---- OpenAI 管理 API ----
    if (u.host === "api.openai.com" && u.pathname.startsWith("/v1/organization/")) {
      if (auth === "Bearer sk-admin-readonly") return res(403, { error: { message: "insufficient permissions" } });
      if (auth !== "Bearer sk-admin-good") return res(401, { error: { message: "bad key sk-admin-good" } });
      if (u.pathname === "/v1/organization/projects" && method === "GET") return res(200, { data: [{ id: "proj_A1", name: "既存", status: "active" }, { id: "proj_Z9", name: "旧", status: "archived" }], has_more: false });
      if (u.pathname === "/v1/organization/projects" && method === "POST") return res(200, { id: "proj_NEW", name: JSON.parse(String(init.body)).name, status: "active" });
      if (u.pathname === "/v1/organization/projects/proj_A1" && method === "GET") return res(200, { id: "proj_A1", name: "既存" });
      if (/^\/v1\/organization\/projects\/proj_[A-Za-z0-9]+\/service_accounts$/.test(u.pathname) && method === "POST") {
        return res(200, { object: "organization.project.service_account", id: "svc_acct_1", name: JSON.parse(String(init.body)).name, role: "member", created_at: 1, api_key: { object: "organization.project.service_account.api_key", value: "sk-svcacct-ISSUED-abcd", name: "Secret Key", created_at: 1, id: "key_1" } });
      }
      if (u.pathname.endsWith("/service_accounts/svc_acct_1") && method === "DELETE") {
        state.saDeleted = true;
        return res(200, { deleted: true });
      }
    }
    // ---- Google ----
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init.body));
      if (p.get("code") !== "CODE1" || !p.get("code_verifier")) return res(400, { error: "invalid_grant" });
      return res(200, { access_token: "ya29.TOKEN", expires_in: 3599, scope: "https://www.googleapis.com/auth/cloud-platform", token_type: "Bearer" });
    }
    if (auth !== "Bearer ya29.TOKEN" && /googleapis\.com$/.test(u.host)) return res(401, { error: { message: "Request had invalid authentication credentials" } });
    if (u.host === "cloudresourcemanager.googleapis.com") return res(200, { projects: [{ projectId: "my-gemini-1", name: "Gemini 用" }, { projectId: "another-proj", name: "別" }] });
    if (u.host === "serviceusage.googleapis.com" && u.pathname.endsWith(":batchEnable")) {
      if (u.pathname.includes("no-perm-proj")) return res(403, { error: { message: "Permission denied to enable service" } });
      return res(200, { name: "operations/acf.enable1", done: false });
    }
    if (u.host === "serviceusage.googleapis.com" && u.pathname === "/v1/operations/acf.enable1") {
      state.polls++;
      return res(200, { name: "operations/acf.enable1", done: true, response: {} });
    }
    if (u.host === "apikeys.googleapis.com" && u.pathname === "/v2/projects/my-gemini-1/locations/global/keys" && method === "POST") {
      const b = JSON.parse(String(init.body));
      if (b.restrictions?.apiTargets?.[0]?.service !== "generativelanguage.googleapis.com") return res(400, { error: { message: "bad" } });
      return res(200, { name: "operations/akmf.k1", done: false });
    }
    if (u.host === "apikeys.googleapis.com" && u.pathname === "/v2/operations/akmf.k1") {
      return res(200, { name: "operations/akmf.k1", done: true, response: { name: "projects/123/locations/global/keys/uid-1", displayName: "要件ナビ" } });
    }
    if (u.host === "apikeys.googleapis.com" && u.pathname === "/v2/projects/123/locations/global/keys/uid-1/keyString") return res(200, { keyString: "AIzaSyISSUEDKEY0000000000000000000wxyz" });
    if (u.host === "apikeys.googleapis.com" && u.pathname === "/v2/projects/123/locations/global/keys/uid-1" && method === "DELETE") {
      state.keyDeleted = true;
      return res(200, { name: "operations/akmf.d1", done: true });
    }
    return res(404, { error: { message: `not mocked: ${method} ${url}` } });
  };
  return { fetch: f as typeof fetch, calls, state };
}

describe("API キーの自動発行と確認", () => {
  let app: ReturnType<typeof createApp>;
  let store: MemoryStore;
  let enc: LocalKeyEncryptor;
  let fp: ReturnType<typeof fakeProviders>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, user = "admin1") => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": user } });
  const post = (path: string, b: unknown, role = "admin", user = "admin1") => app.request(path, as(role, json(b), user));

  const make = (google = true) => {
    store = new MemoryStore();
    enc = new LocalKeyEncryptor(randomBytes(32).toString("base64"));
    fp = fakeProviders();
    app = createApp({
      store,
      encryptor: enc,
      storage: new MemoryStorage(),
      authenticate: devAuthenticator,
      allowMock: true,
      devAuth: true,
      fetchImpl: fp.fetch,
      publicUrl: "http://localhost:8787",
      googleOAuth: google ? { clientId: "cid.apps.googleusercontent.com", clientSecret: "csecret" } : undefined,
      keySetupPollMs: 1,
      jobs: { pollMs: 10 },
    });
  };
  beforeEach(async () => {
    make();
    orgId = (await (await app.request("/api/orgs", json({ name: "テスト組織" }))).json()).id;
  });

  it("メタ情報: AI ごとの自動発行の方法と、使えるか", async () => {
    const m = await (await app.request("/api/meta")).json();
    expect(m.keyAutoIssue).toEqual({ openai: true, gemini: true });
    const modes = Object.fromEntries(m.vendors.map((v: { vendor: string; autoIssue: { mode: string } }) => [v.vendor, v.autoIssue.mode]));
    expect(modes).toMatchObject({ anthropic: "none", openai: "admin-key", gemini: "google-oauth" });
  });

  it("貼り付けたキーを確かめてモデル一覧を返す。間違ったキーは理由を返し、キーの一部も返さない", async () => {
    const ok = await (await post(`/api/orgs/${orgId}/providers/check`, { vendor: "anthropic", apiKey: " sk-ant-api03-good " })).json();
    expect(ok).toEqual({ ok: true, models: [{ id: "claude-test-4-5-20260101", name: "Claude Test 4.5" }, { id: "claude-old-3", name: "Claude Old" }] });
    const bad = await (await post(`/api/orgs/${orgId}/providers/check`, { vendor: "anthropic", apiKey: "sk-ant-api03-bad" })).json();
    expect(bad).toMatchObject({ ok: false, reason: "auth" });
    expect(bad.message).toContain("Claude の API キーが正しくない");
    // OpenAI の 401 の本文にはキーの一部が入るが、返さない
    const o = await (await post(`/api/orgs/${orgId}/providers/check`, { vendor: "openai", apiKey: "sk-proj-WRONGKEY" })).json();
    expect(o.ok).toBe(false);
    expect(JSON.stringify(o)).not.toContain("WRONG");
    // 形式の間違いは提供元に送らない
    const before = fp.calls.length;
    const f = await (await post(`/api/orgs/${orgId}/providers/check`, { vendor: "openai", apiKey: "AIzaSyXXXX" })).json();
    expect(f).toMatchObject({ ok: false, reason: "format" });
    expect(fp.calls.length).toBe(before);
    // 管理者だけ
    expect((await post(`/api/orgs/${orgId}/providers/check`, { vendor: "anthropic", apiKey: "sk-ant-api03-good" }, "editor")).status).toBe(403);
  });

  it("登録済みの AI の接続確認: モデルIDが一覧にあるか（日付なしの別名も可）", async () => {
    const cr = await (await post(`/api/orgs/${orgId}/providers`, { vendor: "anthropic", model: "claude-test-4-5", apiKey: "sk-ant-api03-good" })).json();
    const r = await (await post(`/api/orgs/${orgId}/providers/${cr.id}/check`, {})).json();
    expect(r).toMatchObject({ ok: true, modelFound: true, model: "claude-test-4-5" });
    const cr2 = await (await post(`/api/orgs/${orgId}/providers`, { vendor: "anthropic", model: "claude-typo", apiKey: "sk-ant-api03-good" })).json();
    const r2 = await (await post(`/api/orgs/${orgId}/providers/${cr2.id}/check`, {})).json();
    expect(r2).toMatchObject({ ok: true, modelFound: false });
    expect(r2.message).toContain("一覧にありません");
  });

  it("ChatGPT: 管理用キーでプロジェクトを選び、専用のキーを発行して登録する。管理用キーは保存しない", async () => {
    const pr = await (await post(`/api/orgs/${orgId}/providers/auto/openai/projects`, { adminKey: "sk-admin-good" })).json();
    expect(pr.projects).toEqual([{ id: "proj_A1", name: "既存" }]); // アーカイブ済みは出さない

    const r = await post(`/api/orgs/${orgId}/providers/auto/openai`, { adminKey: "sk-admin-good", projectId: "proj_A1", model: "gpt-test-5", monthlyTokenLimit: 100000 });
    expect(r.status).toBe(201);
    const cred = await r.json();
    expect(cred).toMatchObject({ vendor: "openai", vendorName: "ChatGPT", apiKey: "••••abcd", model: "gpt-test-5", monthlyTokenLimit: 100000 });
    expect(cred.issued).toMatchObject({ by: "openai-admin-key", projectId: "proj_A1", serviceAccountId: "svc_acct_1" });
    expect(JSON.stringify(cred)).not.toContain("ISSUED");
    const saved = (await store.listCredentials(orgId)).find((x) => x.id === cred.id)!;
    expect(await enc.decrypt(saved.encryptedKey!, { orgId })).toBe("sk-svcacct-ISSUED-abcd");
    // サービスアカウント名に組織名
    expect(fp.calls.find((c) => c.url.endsWith("/service_accounts"))!.body).toContain("要件ナビ テスト組織");
    // 管理用キーはどこにも保存しない（監査ログにも残さない）
    const dump = JSON.stringify(await (await app.request(`/api/orgs/${orgId}/audit`, as("admin"))).json());
    expect(dump).not.toContain("sk-admin");
    expect(dump).toContain("svc_acct_1");
    expect(JSON.stringify(await store.listCredentials(orgId))).not.toContain("sk-admin");

    // 発行したキーで接続確認できる
    const ck = await (await post(`/api/orgs/${orgId}/providers/${cred.id}/check`, {})).json();
    expect(ck).toMatchObject({ ok: true, modelFound: true });
    expect(ck.models.map((m: { id: string }) => m.id)).toEqual(["gpt-test-5", "gpt-test-4"]); // チャット用だけ、新しい順
  });

  it("ChatGPT: プロジェクトを新しく作る。間違ったキー・権限のないキーは分かる言葉で返す", async () => {
    const r = await post(`/api/orgs/${orgId}/providers/auto/openai`, { adminKey: "sk-admin-good", projectName: "要件ナビ本番", model: "gpt-test-5" });
    expect(r.status).toBe(201);
    expect((await r.json()).issued).toMatchObject({ projectId: "proj_NEW", projectName: "要件ナビ本番" });

    const m = async (b: unknown) => (await (await post(`/api/orgs/${orgId}/providers/auto/openai/projects`, b)).json()).error as string;
    expect(await m({ adminKey: "sk-proj-normal" })).toContain("通常の API キー");
    expect(await m({ adminKey: "sk-ant-api03-x" })).toContain("Claude のキー");
    expect(await m({ adminKey: "sk-admin-wrong" })).toContain("管理用キーが正しくない");
    expect(await m({ adminKey: "sk-admin-readonly" })).toContain("権限がありません");
    expect(await m({ adminKey: "sk-admin-wrong" })).not.toContain("sk-admin-good");
    expect((await post(`/api/orgs/${orgId}/providers/auto/openai/projects`, { adminKey: "sk-admin-good" }, "editor")).status).toBe(403);
  });

  it("入力が正しくなければ発行しない。発行後に登録できなかったときは、作ったキーを消して残さない", async () => {
    const r = await post(`/api/orgs/${orgId}/providers/auto/openai`, { adminKey: "sk-admin-good", projectId: "proj_A1", model: "gpt-test-5", label: "x".repeat(101) });
    expect(r.status).toBe(400);
    expect(fp.calls.some((c) => c.url.endsWith("/service_accounts"))).toBe(false);

    // 保存に失敗した（データベースの障害など）
    store.addCredential = async () => {
      throw new Error("db down");
    };
    const r2 = await post(`/api/orgs/${orgId}/providers/auto/openai`, { adminKey: "sk-admin-good", projectId: "proj_A1", model: "gpt-test-5" });
    expect(r2.status).toBe(500);
    expect(fp.state.saDeleted).toBe(true);
  });

  it("Gemini: Google でログイン → プロジェクトを選ぶ → Gemini API を有効化し、専用キーを作って登録する", async () => {
    const st = await (await app.request(`/api/orgs/${orgId}/providers/auto/google/start`, as("admin"))).json();
    const u = new URL(st.url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:8787/api/oauth/google/callback");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const state = u.searchParams.get("state")!;
    expect(state).not.toContain("admin1"); // 利用者や検証用の値は暗号化して渡す

    // Google から戻る（要件ナビのログイン情報は付かない）
    const cb = await app.request(`/api/oauth/google/callback?code=CODE1&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    const loc = cb.headers.get("location")!;
    expect(loc.startsWith("http://localhost:8787/#google-session=")).toBe(true);
    expect(loc).not.toContain("ya29"); // アクセストークンは暗号化して渡す
    const session = decodeURIComponent(loc.split("google-session=")[1]!);
    expect(fp.calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!.body).toContain("code_verifier=");

    const pr = await (await post(`/api/orgs/${orgId}/providers/auto/google/projects`, { session })).json();
    expect(pr.projects).toEqual([{ id: "my-gemini-1", name: "Gemini 用" }, { id: "another-proj", name: "別" }]); // 名前順
    // ほかの利用者はこのセッションを使えない
    expect((await post(`/api/orgs/${orgId}/providers/auto/google/projects`, { session }, "admin", "admin2")).status).toBe(403);

    const r = await post(`/api/orgs/${orgId}/providers/auto/google`, { session, projectId: "my-gemini-1", model: "gemini-test-pro" });
    expect(r.status).toBe(201);
    const cred = await r.json();
    expect(cred).toMatchObject({ vendor: "gemini", vendorName: "Gemini", apiKey: "••••wxyz" });
    expect(cred.issued).toMatchObject({ by: "google-oauth", projectId: "my-gemini-1", restrictedTo: "generativelanguage.googleapis.com" });
    expect(fp.state.polls).toBeGreaterThan(0);
    const saved = (await store.listCredentials(orgId)).find((x) => x.id === cred.id)!;
    expect(await enc.decrypt(saved.encryptedKey!, { orgId })).toBe("AIzaSyISSUEDKEY0000000000000000000wxyz");
    const dump = JSON.stringify(await (await app.request(`/api/orgs/${orgId}/audit`, as("admin"))).json());
    expect(dump).not.toContain("ya29");
    expect(dump).not.toContain("AIzaSyISSUED");
    expect(dump).toContain("my-gemini-1");

    // 登録に失敗したら、作ったキーを消す
    store.addCredential = async () => {
      throw new Error("db down");
    };
    expect((await post(`/api/orgs/${orgId}/providers/auto/google`, { session, projectId: "my-gemini-1", model: "gemini-test-pro" })).status).toBe(500);
    expect(fp.state.keyDeleted).toBe(true);
  });

  it("Gemini: 期限切れ・改ざん・別の組織の state は受け付けず、画面にエラーを返す", async () => {
    const bad = await app.request(`/api/oauth/google/callback?code=CODE1&state=${encodeURIComponent(`${orgId}.AAAA`)}`);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toContain("#google-error=");
    const st = new URL((await (await app.request(`/api/orgs/${orgId}/providers/auto/google/start`, as("admin"))).json()).url).searchParams.get("state")!;
    const denied = await app.request(`/api/oauth/google/callback?error=access_denied&state=${encodeURIComponent(st)}`);
    expect(decodeURIComponent(denied.headers.get("location")!)).toContain("取り消されました");
    // 別の組織の管理者は、このセッションを使えない
    const loc = (await app.request(`/api/oauth/google/callback?code=CODE1&state=${encodeURIComponent(st)}`)).headers.get("location")!;
    const session = decodeURIComponent(loc.split("google-session=")[1]!);
    const other = (await (await app.request("/api/orgs", json({ name: "別" }))).json()).id;
    const r = await app.request(`/api/orgs/${other}/providers/auto/google/projects`, { ...json({ session }), headers: { "content-type": "application/json", "x-org-id": other, "x-role": "admin", "x-user-id": "admin1" } });
    expect(r.status).toBe(403);
    // 権限のないプロジェクト
    const np = await (await post(`/api/orgs/${orgId}/providers/auto/google`, { session, projectId: "no-perm-proj", model: "gemini-test-pro" })).json();
    expect(np.error).toContain("権限がありません");
  });

  it("Gemini: Google のログインが設定されていなければ、設定方法を返す", async () => {
    make(false);
    orgId = (await (await app.request("/api/orgs", json({ name: "x" }))).json()).id;
    expect((await (await app.request("/api/meta")).json()).keyAutoIssue).toEqual({ openai: true, gemini: false });
    const r = await app.request(`/api/orgs/${orgId}/providers/auto/google/start`, as("admin"));
    expect(r.status).toBe(501);
    expect((await r.json()).error).toContain("GOOGLE_OAUTH_CLIENT_ID");
  });
});
