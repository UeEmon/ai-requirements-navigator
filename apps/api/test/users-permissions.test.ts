import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { localAuth } from "../src/local-auth.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });
const PW = "kaname-Passw0rd";

/** 要件ナビのログイン（AUTH_MODE=local）で動かす */
function setupLocal(o: { setupToken?: string } = {}) {
  const store = new MemoryStore();
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const now = () => new Date(clock);
  const local = localAuth(store, { scryptN: 1024, passwordMinLength: 10, sessionHours: 12, setupToken: o.setupToken }, now);
  const app = createApp({
    store,
    encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
    storage: new MemoryStorage(),
    authenticate: local.authenticate,
    localAuth: local,
    allowMock: true,
    devAuth: false,
    bootstrapToken: "boot",
    publicUrl: "https://arn.example.com",
    now,
  });
  const call = (tk: string, path: string, init: RequestInit = {}, org?: string) =>
    app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${tk}`, ...(org ? { "x-org-id": org } : {}) } });
  const login = (email: string, password: string) => app.request("/api/auth/local/login", json({ email, password }));
  const tokenOfUrl = (url: string) => url.split("#auth=")[1]!;
  return { app, store, call, login, tokenOfUrl, advance: (ms: number) => (clock += ms) };
}

/** 初期設定（最初の組織と管理者）を済ませる */
async function bootstrap(t: ReturnType<typeof setupLocal>) {
  const r = await t.app.request("/api/auth/local/setup", json({ orgName: "株式会社カナメ", name: "管理 太郎", email: "Admin@Example.com", password: PW }));
  expect(r.status).toBe(201);
  const b = await r.json();
  return { admin: b.token as string, orgId: b.orgId as string };
}

/** 管理者が招待し、招待された人がリンクからパスワードを決める */
async function invite(t: ReturnType<typeof setupLocal>, admin: string, orgId: string, email: string, role: string) {
  const r = await (await t.call(admin, `/api/orgs/${orgId}/members`, json({ email, role }))).json();
  expect(r.setupUrl).toMatch(/^https:\/\/arn\.example\.com\/#auth=/);
  const a = await t.app.request("/api/auth/local/accept", json({ token: t.tokenOfUrl(r.setupUrl), name: email.split("@")[0], password: PW }));
  expect(a.status).toBe(200);
  return { token: (await a.json()).token as string, memberId: r.member.id as string };
}

describe("要件ナビのログイン（AUTH_MODE=local）", () => {
  it("初期設定で最初の組織と管理者を作る（利用者が1人もいないときだけ）", async () => {
    const t = setupLocal();
    expect(await (await t.app.request("/api/auth/local/status")).json()).toMatchObject({ setupRequired: true, setupTokenRequired: false, passwordMinLength: 10 });
    expect((await t.app.request("/api/meta")).status).toBe(200);
    expect((await (await t.app.request("/api/meta")).json()).auth).toBe("local");
    // パスワードの決まり
    const weak = await t.app.request("/api/auth/local/setup", json({ orgName: "x", email: "a@example.com", password: "short" }));
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toContain("10 文字以上");

    const { admin, orgId } = await bootstrap(t);
    expect(admin).toMatch(/^arn_s_/);
    const me = await (await t.call(admin, "/api/me")).json();
    expect(me).toMatchObject({ orgId, role: "admin", email: "admin@example.com", name: "管理 太郎", auth: "local", orgs: [{ orgId, name: "株式会社カナメ", role: "admin" }] });
    expect(me.permissions).toContain("member.manage");
    // 2回目はできない
    expect((await (await t.app.request("/api/auth/local/status")).json()).setupRequired).toBe(false);
    expect((await t.app.request("/api/auth/local/setup", json({ orgName: "乗っ取り", email: "evil@example.com", password: PW }))).status).toBe(409);
    // パスワードもトークンもそのままは保存しない
    const u = await t.store.getUserByEmail("admin@example.com");
    expect(u!.passwordHash).toMatch(/^scrypt\$/);
    expect(u!.passwordHash).not.toContain(PW);
    expect(await t.store.getSessionByHash(admin)).toBeNull();
  });

  it("LOCAL_SETUP_TOKEN を設定すると、初期設定にその値が必要", async () => {
    const t = setupLocal({ setupToken: "s3cret" });
    expect((await (await t.app.request("/api/auth/local/status")).json()).setupTokenRequired).toBe(true);
    expect((await t.app.request("/api/auth/local/setup", json({ orgName: "x", email: "a@example.com", password: PW }))).status).toBe(403);
    expect((await t.app.request("/api/auth/local/setup", json({ orgName: "x", email: "a@example.com", password: PW, setupToken: "s3cret" }))).status).toBe(201);
  });

  it("ログイン・ログアウト。間違いが続くとロックし、存在しない人とも同じ答え", async () => {
    const t = setupLocal();
    await bootstrap(t);
    const ok = await t.login("admin@example.com", PW);
    expect(ok.status).toBe(200);
    const s = await ok.json();
    expect(s).toMatchObject({ user: { email: "admin@example.com" }, expiresIn: 12 * 3600 });

    const nobody = await t.login("nobody@example.com", PW);
    expect(nobody.status).toBe(401);
    const wrong = await t.login("admin@example.com", "wrong-password");
    expect(wrong.status).toBe(401);
    expect((await nobody.json()).error).toBe((await wrong.json()).error);
    for (let i = 0; i < 4; i++) await t.login("admin@example.com", "wrong-password");
    // ロック中は正しいパスワードでも入れない
    const locked = await t.login("admin@example.com", PW);
    expect(locked.status).toBe(429);
    t.advance(16 * 60_000);
    expect((await t.login("admin@example.com", PW)).status).toBe(200);

    // ログアウトすると、そのトークンは使えない
    expect((await t.call(s.token, "/api/auth/local/logout", { method: "POST" })).status).toBe(204);
    expect((await t.call(s.token, "/api/me")).status).toBe(401);
    // 期限切れ
    const s2 = await (await t.login("admin@example.com", PW)).json();
    t.advance(13 * 3600_000);
    expect((await t.call(s2.token, "/api/me")).status).toBe(401);
  });

  it("招待すると、パスワードを決める一回限りのリンクを発行する。招待されていない人は入れない", async () => {
    const t = setupLocal();
    const { admin, orgId } = await bootstrap(t);
    const r = await (await t.call(admin, `/api/orgs/${orgId}/members`, json({ email: "Hanako@Example.com", role: "editor" }))).json();
    expect(r.member).toMatchObject({ email: "hanako@example.com", status: "invited" });
    expect(r.message).toContain(r.setupUrl);
    const token = t.tokenOfUrl(r.setupUrl);
    expect(await (await t.app.request("/api/auth/local/ticket", json({ token }))).json()).toMatchObject({ email: "hanako@example.com", purpose: "setup", orgName: "株式会社カナメ" });
    // 招待中は、まだアカウントがない
    expect((await (await t.call(admin, `/api/orgs/${orgId}/members`)).json()).members.find((m: { email: string }) => m.email === "hanako@example.com").hasPassword).toBe(false);
    expect((await t.app.request("/api/auth/local/accept", json({ token, password: "hanako@example.com" }))).status).toBe(400);
    const a = await t.app.request("/api/auth/local/accept", json({ token, name: "花子", password: PW }));
    expect(a.status).toBe(200);
    const hanako = (await a.json()).token;
    expect(await (await t.call(hanako, "/api/me")).json()).toMatchObject({ orgId, role: "editor", name: "花子" });
    // リンクは1回だけ
    expect((await t.app.request("/api/auth/local/accept", json({ token, password: PW }))).status).toBe(400);
    const list = (await (await t.call(admin, `/api/orgs/${orgId}/members`)).json()).members;
    expect(list.find((m: { email: string }) => m.email === "hanako@example.com")).toMatchObject({ status: "active", linked: true, hasPassword: true });
    // 編集者はユーザーを管理できない
    expect((await t.call(hanako, `/api/orgs/${orgId}/members`)).status).toBe(403);

    // 招待されていない人は、管理者でもアカウントを作れない（ログインもできない）
    expect((await t.login("stranger@example.com", PW)).status).toBe(401);
    // 外すと入れない
    const hm = list.find((m: { email: string }) => m.email === "hanako@example.com");
    await t.call(admin, `/api/orgs/${orgId}/members/${hm.id}`, { method: "DELETE" });
    expect((await t.call(hanako, `/api/orgs/${orgId}/projects`, {}, orgId)).status).toBe(404);
    const again = await t.login("hanako@example.com", PW);
    expect(again.status).toBe(403);
    expect((await again.json()).error).toContain("外されています");
  });

  it("パスワードの変更（ほかの端末のログインは終わる）と、管理者によるパスワードの再設定", async () => {
    const t = setupLocal();
    const { admin, orgId } = await bootstrap(t);
    const { memberId } = await invite(t, admin, orgId, "taro@example.com", "viewer");
    const s1 = (await (await t.login("taro@example.com", PW)).json()).token;
    const s2 = (await (await t.login("taro@example.com", PW)).json()).token;
    expect((await t.call(s1, "/api/auth/local/password", json({ currentPassword: "nope-nope-nope", newPassword: "another-Passw0rd" }))).status).toBe(400);
    const ch = await (await t.call(s1, "/api/auth/local/password", json({ currentPassword: PW, newPassword: "another-Passw0rd" }))).json();
    expect(ch.endedSessions).toBeGreaterThanOrEqual(1);
    expect((await t.call(s1, "/api/me")).status).toBe(200);
    expect((await t.call(s2, "/api/me")).status).toBe(401);
    expect((await t.login("taro@example.com", PW)).status).toBe(401);
    expect((await t.login("taro@example.com", "another-Passw0rd")).status).toBe(200);

    // 忘れたとき: 管理者が再設定のリンクを発行する
    const link = await (await t.call(admin, `/api/orgs/${orgId}/members/${memberId}/link`, { method: "POST" })).json();
    expect(link.purpose).toBe("reset");
    expect((await t.app.request("/api/auth/local/accept", json({ token: t.tokenOfUrl(link.url), password: "third-Passw0rd!" }))).status).toBe(200);
    expect((await t.call(s1, "/api/me")).status).toBe(401); // 再設定でログインは終わる
    expect((await t.login("taro@example.com", "third-Passw0rd!")).status).toBe(200);
    // 自分の表示名
    const tk = (await (await t.login("taro@example.com", "third-Passw0rd!")).json()).token;
    expect((await (await t.call(tk, "/api/auth/local/profile", json({ name: "太郎" }, "PATCH"))).json()).name).toBe("太郎");
    const log = await (await t.call(admin, `/api/orgs/${orgId}/audit?action=auth`)).json();
    expect(log.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["auth.login", "auth.setup", "auth.password", "auth.reset"]));
  });

  it("ほかの組織にも入っている人のパスワードは、管理者は再設定できない（乗っ取りを防ぐ）", async () => {
    const t = setupLocal();
    const { admin, orgId } = await bootstrap(t);
    await invite(t, admin, orgId, "shared@example.com", "editor");
    // 組織B（初期設定用トークンで作る）の管理者は shared@example.com を招待できるが、パスワードは変えられない
    const b = await (await t.app.request("/api/orgs", { ...json({ name: "組織B", adminEmail: "boss-b@example.com" }), headers: { "content-type": "application/json", "x-bootstrap-token": "boot" } })).json();
    expect(b.adminSetupUrl).toMatch(/#auth=/);
    const bossB = (await (await t.app.request("/api/auth/local/accept", json({ token: t.tokenOfUrl(b.adminSetupUrl), password: PW }))).json()).token;
    const inv = await (await t.call(bossB, `/api/orgs/${b.id}/members`, json({ email: "shared@example.com", role: "viewer" }), b.id)).json();
    expect(inv.setupUrl).toBeNull(); // アカウントがあるので、いつものパスワードでログイン
    expect(inv.message).toContain("いつものメールアドレス");
    const r = await t.call(bossB, `/api/orgs/${b.id}/members/${inv.member.id}/link`, { method: "POST" }, b.id);
    expect(r.status).toBe(409);
    // 本人がログインすると組織Bにも入れる
    const s = (await (await t.login("shared@example.com", PW)).json()).token;
    expect((await (await t.call(s, "/api/me", {}, b.id)).json())).toMatchObject({ orgId: b.id, role: "viewer" });
    // 組織の作成には、最初の管理者のメールアドレスが必要（管理者は組織に1人以上）
    expect((await t.app.request("/api/orgs", { ...json({ name: "組織C" }), headers: { "content-type": "application/json", "x-bootstrap-token": "boot" } })).status).toBe(400);
  });

  it("組織の管理者は1人以上。最後の管理者は役割を変えられず、外せない", async () => {
    const t = setupLocal();
    const { admin, orgId } = await bootstrap(t);
    const members = (await (await t.call(admin, `/api/orgs/${orgId}/members`)).json()).members;
    const me = members[0];
    expect((await t.call(admin, `/api/orgs/${orgId}/members/${me.id}`, json({ role: "editor" }, "PATCH"))).status).toBe(409);
    expect((await t.call(admin, `/api/orgs/${orgId}/members/${me.id}`, { method: "DELETE" })).status).toBe(409);
    const { memberId } = await invite(t, admin, orgId, "second@example.com", "admin");
    expect((await t.call(admin, `/api/orgs/${orgId}/members/${me.id}`, json({ role: "editor" }, "PATCH"))).status).toBe(200);
    expect((await t.call(admin, `/api/orgs/${orgId}/members/${memberId}`, json({ role: "viewer" }, "PATCH"))).status).toBe(403); // もう管理者ではない
  });
});

describe("組織設定と役割ごとの権限", () => {
  const setup = () => {
    const store = new MemoryStore();
    const app = createApp({ store, encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")), storage: new MemoryStorage(), authenticate: devAuthenticator, allowMock: true, devAuth: true });
    return { app, store };
  };

  it("組織設定（名前・説明・問い合わせ先・招待できるドメイン・月間上限）を管理者が変える", async () => {
    const t = setup();
    const orgId = (await (await t.app.request("/api/orgs", json({ name: "組織" }))).json()).id;
    const as = (role: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": `u-${role}` } });
    const patch = { name: "開発部", description: "社内システムの要件定義", contactEmail: "it@example.co.jp", allowedEmailDomains: ["@Example.co.jp", "example.co.jp", "partner.jp"], monthlyTokenLimit: 500000 };
    expect((await t.app.request(`/api/orgs/${orgId}`, as("editor", json(patch, "PATCH")))).status).toBe(403);
    const o = await (await t.app.request(`/api/orgs/${orgId}`, as("admin", json(patch, "PATCH")))).json();
    expect(o).toMatchObject({ name: "開発部", description: "社内システムの要件定義", contactEmail: "it@example.co.jp", allowedEmailDomains: ["example.co.jp", "partner.jp"], monthlyTokenLimit: 500000 });
    expect((await t.app.request(`/api/orgs/${orgId}`, as("admin", json({ allowedEmailDomains: ["not a domain"] }, "PATCH")))).status).toBe(400);
    const s = await (await t.app.request(`/api/orgs/${orgId}/summary`, as("viewer"))).json();
    expect(s.org).toMatchObject({ name: "開発部", contactEmail: "it@example.co.jp", allowedEmailDomains: ["example.co.jp", "partner.jp"] });
    // 招待できるのは決めたドメインだけ
    const ng = await t.app.request(`/api/orgs/${orgId}/members`, as("admin", json({ email: "x@gmail.com", role: "viewer" })));
    expect(ng.status).toBe(400);
    expect((await ng.json()).error).toContain("@example.co.jp");
    expect((await t.app.request(`/api/orgs/${orgId}/members`, as("admin", json({ email: "y@partner.jp", role: "viewer" })))).status).toBe(201);
    const log = await (await t.app.request(`/api/orgs/${orgId}/audit?action=org.update`, as("admin"))).json();
    expect(log.entries[0].detail.after).toMatchObject({ name: "開発部", monthlyTokenLimit: 500000 });
  });

  it("役割ごとの権限を変える。管理者だけの権限は渡せず、閲覧は外せない", async () => {
    const t = setup();
    const orgId = (await (await t.app.request("/api/orgs", json({ name: "組織" }))).json()).id;
    const as = (role: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": `u-${role}` } });
    const prov = await (await t.app.request(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label: "m" })))).json();
    const mk = (role: string) => t.app.request(`/api/orgs/${orgId}/projects`, as(role, json({ name: "p", aiConfig: { mode: "single", generatorIds: [prov.id] } })));

    // 既定
    const m0 = await (await t.app.request(`/api/orgs/${orgId}/permissions`, as("viewer"))).json();
    expect(m0.roles.find((r: { role: string }) => r.role === "viewer").permissions).toEqual(["project.view", "export"]);
    expect(m0.permissions.find((p: { key: string }) => p.key === "member.manage").locked).toBe("admin");
    expect((await mk("viewer")).status).toBe(403);
    expect((await (await mk("viewer")).json()).error).toContain("「プロジェクトの作成」の権限");
    const p = await (await mk("editor")).json();
    expect((await t.app.request(`/api/projects/${p.id}/tests.csv`, as("viewer"))).status).toBe(200);
    expect((await t.app.request(`/api/orgs/${orgId}/audit`, as("editor"))).status).toBe(403);

    // 変更は管理者だけ
    expect((await t.app.request(`/api/orgs/${orgId}/permissions`, as("editor", json({ roles: { editor: ["audit.view"] } }, "PUT")))).status).toBe(403);
    const m1 = await (await t.app.request(`/api/orgs/${orgId}/permissions`, as("admin", json({ roles: { viewer: ["project.create", "member.manage", "org.settings"], editor: ["project.create", "requirements.edit", "audit.view"] } }, "PUT")))).json();
    const viewer = m1.roles.find((r: { role: string }) => r.role === "viewer");
    expect(viewer).toMatchObject({ customized: true, permissions: ["project.view", "project.create"] }); // 管理者だけの権限は付かない・出力を外した
    expect((await mk("viewer")).status).toBe(201);
    expect((await t.app.request(`/api/projects/${p.id}/tests.csv`, as("viewer"))).status).toBe(403);
    expect((await t.app.request(`/api/orgs/${orgId}/members`, as("viewer"))).status).toBe(403);
    expect((await t.app.request(`/api/orgs/${orgId}/audit`, as("editor"))).status).toBe(200);
    // 編集者からレビューの承認を外した（既定より狭くもできる）
    expect((await t.app.request(`/api/projects/${p.id}/acceptance/check`, as("editor", json({})))).status).toBe(403);
    expect((await (await t.app.request("/api/me", as("viewer"))).json()).permissions).toEqual(["project.view", "project.create"]);
    // 管理者は常にすべて
    expect((await t.app.request(`/api/orgs/${orgId}/members`, as("admin"))).status).toBe(200);

    // 既定に戻す
    const m2 = await (await t.app.request(`/api/orgs/${orgId}/permissions`, as("admin", json({ reset: true }, "PUT")))).json();
    expect(m2.roles.every((r: { customized: boolean }) => !r.customized)).toBe(true);
    expect((await mk("viewer")).status).toBe(403);
    const log = await (await t.app.request(`/api/orgs/${orgId}/audit?action=org.permissions`, as("admin"))).json();
    expect(log.entries.length).toBe(2);
    expect(log.entries[1].detail.changes).toEqual(expect.arrayContaining([expect.objectContaining({ role: "viewer", added: ["project.create"], removed: ["export"] })]));
  });
});
