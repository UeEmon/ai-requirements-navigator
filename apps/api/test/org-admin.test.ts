import { randomBytes } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator, OidcClient, OidcDiscoveryCache, oidcAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const ISSUER = "https://idp.example.com/realms/arn";
const CLIENT = "arn-web";
const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

/** ログイン画面（OIDC）で動かす。トークンは手元の鍵で作る */
async function setupOidc() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(CLIENT).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  let nextIdToken = "";
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith("/.well-known/openid-configuration"))
      return Response.json({ authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/certs` });
    if (String(url).endsWith("/token")) return Response.json({ id_token: nextIdToken, refresh_token: "rt", expires_in: 300 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const store = new MemoryStore();
  const discovery = new OidcDiscoveryCache(`${ISSUER}/.well-known/openid-configuration`, fetchImpl);
  const opts = { issuer: ISSUER, audience: CLIENT, orgClaim: "org_id", roleClaim: "roles" };
  const app = createApp({
    store,
    encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
    storage: new MemoryStorage(),
    authenticate: oidcAuthenticator({ ...opts, keys: createLocalJWKSet({ keys: [jwk] }) }, discovery),
    allowMock: true,
    devAuth: false,
    bootstrapToken: "boot",
    publicUrl: "https://arn.example.com",
    oidc: { client: new OidcClient(discovery, { clientId: CLIENT, scope: "openid email", fetchImpl }), orgClaim: "org_id", roleClaim: "roles" },
  });
  /** 利用者のトークン */
  const user = async (sub: string, email: string, extra: Record<string, unknown> = {}) => sign({ sub, email, email_verified: true, name: sub, ...extra });
  const call = (tk: string, path: string, init: RequestInit = {}, org?: string) =>
    app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${tk}`, ...(org ? { "x-org-id": org } : {}) } });
  /** ログイン画面からのログイン（コード交換） */
  const login = async (tk: string) => {
    nextIdToken = tk;
    return app.request("/api/auth/token", json({ code: "c", codeVerifier: "v".repeat(43), redirectUri: "https://arn.example.com/" }));
  };
  const createOrg = async (name: string, adminEmail?: string) =>
    (await app.request("/api/orgs", { ...json({ name, adminEmail }), headers: { "content-type": "application/json", "x-bootstrap-token": "boot" } })).json();
  return { app, store, user, call, login, createOrg, sign };
}

describe("組織の管理（メンバーと役割は要件ナビで管理）", () => {
  it("組織の作成時に最初の管理者を招待し、確認済みのメールアドレスでログインすると管理者になる", async () => {
    const o = await setupOidc();
    const org = await o.createOrg("株式会社サンプル", "Boss@Example.com");
    expect(org.adminInvited).toBe("boss@example.com");

    // 招待されていない人は、ログインできても組織に入れない
    const stranger = await o.user("s1", "who@example.com");
    const ng = await o.login(stranger);
    expect(ng.status).toBe(403);
    expect((await ng.json()).error).toContain("まだどの組織にも招待されていません");
    // メールアドレスが未確認だと結び付けない
    const unverified = await o.sign({ sub: "b0", email: "boss@example.com", email_verified: false });
    expect((await (await o.login(unverified)).json()).error).toContain("メールアドレスがまだ確認されていません");

    const boss = await o.user("b1", "boss@example.com", { name: "社長" });
    expect((await o.login(boss)).status).toBe(200);
    const me = await (await o.call(boss, "/api/me")).json();
    expect(me).toMatchObject({ orgId: org.id, role: "admin", email: "boss@example.com", orgs: [{ orgId: org.id, name: "株式会社サンプル", role: "admin" }] });
    const members = await (await o.call(boss, `/api/orgs/${org.id}/members`)).json();
    expect(members.members).toEqual([expect.objectContaining({ email: "boss@example.com", role: "admin", status: "active", source: "bootstrap", linked: true, name: "社長" })]);
    expect(members.loginUrl).toBe("https://arn.example.com/");
  });

  it("管理者が招待・役割の変更・外すを行う。最後の管理者は外せない", async () => {
    const o = await setupOidc();
    const org = await o.createOrg("組織A", "admin@example.com");
    const admin = await o.user("a1", "admin@example.com");
    await o.login(admin);

    const inv = await o.call(admin, `/api/orgs/${org.id}/members`, json({ email: "Dev@Example.com", role: "editor", name: "開発 花子" }));
    expect(inv.status).toBe(201);
    const ib = await inv.json();
    expect(ib.member).toMatchObject({ email: "dev@example.com", role: "editor", status: "invited", linked: false });
    expect(ib.message).toContain("https://arn.example.com/");
    expect(ib.message).toContain("編集者");
    expect((await o.call(admin, `/api/orgs/${org.id}/members`, json({ email: "dev@example.com", role: "viewer" }))).status).toBe(409);

    // 招待された人がログイン → 編集者。メンバーの管理はできない
    const dev = await o.user("d1", "dev@example.com");
    expect((await o.login(dev)).status).toBe(200);
    expect((await (await o.call(dev, "/api/me")).json()).role).toBe("editor");
    expect((await o.call(dev, `/api/orgs/${org.id}/members`)).status).toBe(403);
    expect((await o.call(dev, `/api/orgs/${org.id}/providers`)).status).toBe(200);

    // 役割の変更はすぐ反映される
    const id = ib.member.id;
    const up = await (await o.call(admin, `/api/orgs/${org.id}/members/${id}`, json({ role: "admin" }, "PATCH"))).json();
    expect(up.role).toBe("admin");
    expect((await o.call(dev, `/api/orgs/${org.id}/members`)).status).toBe(200);

    // 最後の管理者は外せない・降格できない（管理者が2人なら、片方は外せる）
    const list = (await (await o.call(admin, `/api/orgs/${org.id}/members`)).json()).members;
    const adminId = list.find((m: { email: string }) => m.email === "admin@example.com").id;
    expect((await o.call(admin, `/api/orgs/${org.id}/members/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await o.call(dev, `/api/orgs/${org.id}/providers`)).status).toBe(404); // 外された人は入れない
    const last = await o.call(admin, `/api/orgs/${org.id}/members/${adminId}`, json({ role: "viewer" }, "PATCH"));
    expect(last.status).toBe(409);
    expect((await last.json()).error).toContain("管理者が1人もいなくなる");
    expect((await o.call(admin, `/api/orgs/${org.id}/members/${adminId}`, { method: "DELETE" })).status).toBe(409);

    // 外した人を招待し直すと、そのまま入れる
    expect((await o.call(admin, `/api/orgs/${org.id}/members`, json({ email: "dev@example.com", role: "viewer" }))).status).toBe(201);
    expect((await (await o.call(dev, "/api/me")).json()).role).toBe("viewer");
    // まだログインしていない招待を取り消すと、記録ごと消える
    const x = await (await o.call(admin, `/api/orgs/${org.id}/members`, json({ email: "x@example.com", role: "viewer" }))).json();
    expect((await o.call(admin, `/api/orgs/${org.id}/members/${x.member.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await o.call(admin, `/api/orgs/${org.id}/members?removed=1`)).json()).members.map((m: { email: string }) => m.email)).not.toContain("x@example.com");

    // 監査ログ
    const log = await (await o.call(admin, `/api/orgs/${org.id}/audit?action=member`)).json();
    expect(log.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["member.invite", "member.update", "member.remove"]));
  });

  it("1人で複数の組織に入れ、画面で選んだ組織（x-org-id）で使う", async () => {
    const o = await setupOidc();
    const a = await o.createOrg("組織A", "pm@example.com");
    const b = await o.createOrg("組織B", "boss-b@example.com");
    const bossB = await o.user("bb", "boss-b@example.com");
    await o.login(bossB);
    await o.call(bossB, `/api/orgs/${b.id}/members`, json({ email: "pm@example.com", role: "reviewer" }));

    const pm = await o.user("pm", "pm@example.com");
    expect((await o.login(pm)).status).toBe(200);
    const me = await (await o.call(pm, "/api/me")).json();
    expect(me.orgs.map((x: { name: string; role: string }) => `${x.name}:${x.role}`).sort()).toEqual(["組織A:admin", "組織B:reviewer"]);
    // 組織を選んでいないと、どちらにも入れない
    expect((await o.call(pm, `/api/orgs/${a.id}/providers`)).status).toBe(404);
    expect((await o.call(pm, `/api/orgs/${a.id}/members`, {}, a.id)).status).toBe(200);
    expect((await o.call(pm, `/api/orgs/${b.id}/members`, {}, b.id)).status).toBe(403); // 組織B ではレビュー担当
    expect((await o.call(pm, `/api/orgs/${b.id}/providers`, {}, b.id)).status).toBe(200);
  });

  it("以前の運用（トークンのクレームで組織・役割）の人は、最初のログインでメンバーになり、以後は画面の設定に従う", async () => {
    const o = await setupOidc();
    const org = await o.createOrg("組織C");
    const legacy = await o.user("l1", "legacy@example.com", { org_id: org.id, roles: ["admin"] });
    expect((await o.login(legacy)).status).toBe(200);
    const other = await o.user("l2", "old@example.com", { org_id: org.id, roles: ["editor"] });
    await o.login(other);
    const ms = (await (await o.call(legacy, `/api/orgs/${org.id}/members`)).json()).members;
    expect(ms.map((m: { email: string; role: string; source: string }) => `${m.email}:${m.role}:${m.source}`)).toEqual(["legacy@example.com:admin:idp", "old@example.com:editor:idp"]);
    // 画面で閲覧者にすると、クレームが編集者でも閲覧者
    const oldId = ms.find((m: { email: string }) => m.email === "old@example.com").id;
    await o.call(legacy, `/api/orgs/${org.id}/members/${oldId}`, json({ role: "viewer" }, "PATCH"));
    expect((await (await o.call(other, "/api/me")).json()).role).toBe("viewer");
    // 外すと、クレームがあっても入れない
    await o.call(legacy, `/api/orgs/${org.id}/members/${oldId}`, { method: "DELETE" });
    expect((await o.call(other, `/api/orgs/${org.id}/providers`)).status).toBe(404);
    expect((await o.login(other)).status).toBe(403);
  });

  it("組織の概要と名前の変更", async () => {
    const o = await setupOidc();
    const org = await o.createOrg("旧名", "admin@example.com");
    const admin = await o.user("a1", "admin@example.com");
    await o.login(admin);
    await o.call(admin, `/api/orgs/${org.id}/members`, json({ email: "v@example.com", role: "viewer" }));
    const s = await (await o.call(admin, `/api/orgs/${org.id}/summary`)).json();
    expect(s).toMatchObject({ org: { name: "旧名" }, counts: { members: { active: 1, invited: 1, admins: 1 }, providers: 0, integrations: 0, projects: { active: 0, archived: 0 } }, usage: { used: 0, limit: null }, memberManagement: "app" });
    const r = await o.call(admin, `/api/orgs/${org.id}`, json({ name: "新名" }, "PATCH"));
    expect((await r.json()).name).toBe("新名");
    expect((await (await o.call(admin, "/api/me")).json()).orgs[0].name).toBe("新名");
  });
});

describe("プロジェクトの整理", () => {
  const setup = () => {
    const store = new MemoryStore();
    const app = createApp({ store, encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")), storage: new MemoryStorage(), authenticate: devAuthenticator, allowMock: true, devAuth: true });
    return { app, store };
  };
  it("名前・目的の変更（編集者）、アーカイブと元に戻す（管理者）、名前を入れて削除（管理者）", async () => {
    const t = setup();
    const orgId = (await (await t.app.request("/api/orgs", json({ name: "組織" }))).json()).id;
    const as = (role: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": `u-${role}` } });
    const prov = await (await t.app.request(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label: "m" })))).json();
    const mk = async (name: string) => (await (await t.app.request(`/api/orgs/${orgId}/projects`, as("editor", json({ name, aiConfig: { mode: "single", generatorIds: [prov.id] } })))).json()).id as string;
    const p1 = await mk("予約");
    const p2 = await mk("備品");
    const sample = (await (await t.app.request(`/api/orgs/${orgId}/samples`, as("editor", json({})))).json()).project.id as string;
    const names = async (q = "") => (await (await t.app.request(`/api/orgs/${orgId}/projects${q}`, as("viewer"))).json()).map((p: { name: string }) => p.name);

    // 名前・目的
    const up = await (await t.app.request(`/api/projects/${p1}`, as("editor", json({ name: "Web予約", purpose: "電話を減らす" }, "PATCH")))).json();
    expect(up).toMatchObject({ name: "Web予約", purpose: "電話を減らす" });
    expect((await t.app.request(`/api/projects/${p1}`, as("viewer", json({ name: "x" }, "PATCH")))).status).toBe(403);

    // アーカイブ（管理者）
    expect((await t.app.request(`/api/projects/${p2}`, as("editor", json({ archived: true }, "PATCH")))).status).toBe(403);
    const ar = await (await t.app.request(`/api/projects/${p2}`, as("admin", json({ archived: true }, "PATCH")))).json();
    expect(ar.archivedAt).toBeTruthy();
    expect(await names()).not.toContain("備品");
    expect(await names("?archived=1")).toEqual(["備品"]);
    expect((await t.app.request(`/api/projects/${p2}`, as("viewer"))).status).toBe(200); // 開けば見られる
    await t.app.request(`/api/projects/${p2}`, as("admin", json({ archived: false }, "PATCH")));
    expect(await names()).toContain("備品");

    // 削除: 名前の確認が必要。要件などもまとめて消える
    expect((await t.app.request(`/api/projects/${sample}`, as("editor", json({ confirmName: "x" }, "DELETE")))).status).toBe(403);
    const wrong = await t.app.request(`/api/projects/${sample}`, as("admin", json({ confirmName: "違う名前" }, "DELETE")));
    expect(wrong.status).toBe(400);
    const sp = await (await t.app.request(`/api/projects/${sample}`, as("viewer"))).json();
    expect((await t.store.listRequirements(sample)).length).toBeGreaterThan(10);
    expect((await t.app.request(`/api/projects/${sample}`, as("admin", json({ confirmName: sp.name }, "DELETE")))).status).toBe(204);
    expect((await t.app.request(`/api/projects/${sample}`, as("viewer"))).status).toBe(404);
    expect(await t.store.listRequirements(sample)).toEqual([]);
    expect(await names()).not.toContain(sp.name);
    // 監査ログには残る
    const log = await (await t.app.request(`/api/orgs/${orgId}/audit?action=project`, as("admin"))).json();
    expect(log.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["project.update", "project.archive", "project.unarchive", "project.delete"]));
  });

  it("開発用ログインでは、メンバーの設定は使わない（一覧と招待は試せる）", async () => {
    const t = setup();
    const orgId = (await (await t.app.request("/api/orgs", json({ name: "組織" }))).json()).id;
    const h = { "x-org-id": orgId, "x-role": "admin", "x-user-id": "dev-admin" };
    expect((await (await t.app.request(`/api/orgs/${orgId}/members`, { ...json({ email: "a@example.com", role: "editor" }), headers: { ...h, "content-type": "application/json" } })).json()).member.status).toBe("invited");
    expect((await (await t.app.request(`/api/orgs/${orgId}/members`, { headers: h })).json()).management).toBe("dev");
    expect((await (await t.app.request("/api/me", { headers: h })).json())).toMatchObject({ dev: true, role: "admin" });
  });
});
