import { randomBytes } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator, OidcClient, OidcDiscoveryCache, oidcAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

function setup() {
  const store = new MemoryStore();
  const encryptor = new LocalKeyEncryptor(randomBytes(32).toString("base64"));
  const app = createApp({
    store,
    encryptor,
    storage: new MemoryStorage(),
    authenticate: devAuthenticator,
    allowMock: true,
    devAuth: true,
    random: () => 0.5,
    fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    jobs: { pollMs: 10 },
  });
  return { app, store };
}

describe("非専門家向けの支援・要件の手直し・非同期実行・監査ログ", () => {
  let t: ReturnType<typeof setup>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, org = orgId, user = "u1") => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-org-id": org, "x-role": role, "x-user-id": user },
  });
  const req = (path: string, init: RequestInit = {}) => t.app.request(path, init);

  async function project(mode: "multi" | "single" = "multi") {
    const ids: string[] = [];
    for (const label of ["Claude役", "GPT役", "評価役"]) {
      ids.push((await (await req(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label })))).json()).id);
    }
    const aiConfig = mode === "multi" ? { mode, generatorIds: [ids[0], ids[1]], evaluatorId: ids[2] } : { mode, generatorIds: [ids[0]] };
    return (await req(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "予約", aiConfig })))).json();
  }
  async function decide(projectId: string, answer = "電話予約を減らしたい", advancePhase = false) {
    const round = await (await req(`/api/projects/${projectId}/rounds`, as("editor", json({ answer })))).json();
    return (await req(`/api/rounds/${round.id}/decision`, as("editor", json({ pick: "merged", advancePhase })))).json();
  }

  beforeEach(async () => {
    t = setup();
    orgId = (await (await req("/api/orgs", json({ name: "組織" }))).json()).id;
  });

  /* ---------- 質問ガイド ---------- */
  it("質問ガイド: 観点の網羅状況に応じて、次の質問・回答候補・用語解説を返す", async () => {
    const p = await project();
    const g0 = await (await req(`/api/projects/${p.id}/guide`, as("viewer"))).json();
    expect(g0.source).toBe("default"); // まだAIで作っていない
    expect(g0.options.length).toBeGreaterThan(0);

    const g1 = await (await req(`/api/projects/${p.id}/guide`, as("editor", json({})))).json();
    expect(g1.source).toBe("ai");
    expect(g1.covered).toEqual([]);
    expect(g1.question).toContain("解決したい課題");
    expect(g1.glossary.map((x: { term: string }) => x.term)).toContain("応答時間");

    await decide(p.id); // 統合案（3項目）を採用、フェーズはそのまま
    const proj = await (await req(`/api/projects/${p.id}`, as("viewer"))).json();
    expect(proj.phaseKey).toBe("purpose");
    expect((await (await req(`/api/projects/${p.id}/guide`, as("viewer"))).json()).stale).toBe(true);

    const g2 = await (await req(`/api/projects/${p.id}/guide`, as("editor", json({})))).json();
    expect(g2.covered).toEqual(["解決したい課題", "達成したい状態", "効果の測り方"]);
    expect(g2.missing).toEqual(["対象範囲と対象外"]);
    expect(g2.coverage).toBeCloseTo(0.75);
    expect(g2.stale).toBe(false);

    const cov = await (await req(`/api/projects/${p.id}/coverage`, as("viewer"))).json();
    expect(cov.phases[0]).toMatchObject({ key: "purpose", checked: true });
    expect(cov.overall).toBeCloseTo(3 / 32); // 7段階の観点の合計 32

    // 観点がそろわなくても、利用者の判断で次へ進める
    const moved = await (await req(`/api/projects/${p.id}/phase`, as("editor", json({ phaseKey: "actors" })))).json();
    expect(moved.phaseKey).toBe("actors");
    expect((await req(`/api/projects/${p.id}/phase`, as("editor", json({ phaseKey: "nope" })))).status).toBe(400);
    expect((await req(`/api/projects/${p.id}/phase`, as("viewer", json({ phaseKey: "flow" })))).status).toBe(403);
  });

  it("質問ガイド: AIが使えなくても既定の質問を返す", async () => {
    const cr = await (await req(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "openai", model: "m", apiKey: "k" })))).json();
    const p = await (await req(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "x", aiConfig: { mode: "single", generatorIds: [cr.id] } })))).json();
    const g = await (await req(`/api/projects/${p.id}/guide`, as("editor", json({})))).json();
    expect(g.source).toBe("default");
    expect(g.failures).toBe(1);
  });

  /* ---------- 要件の手直し ---------- */
  it("要件の編集は版を残し、削除は論理削除で番号を再利用しない", async () => {
    const p = await project();
    const d = await decide(p.id);
    const r = d.added[0];

    expect((await req(`/api/requirements/${r.id}`, as("viewer", json({ title: "x" }, "PATCH")))).status).toBe(403);
    expect((await req(`/api/requirements/${r.id}`, as("editor", json({}, "PATCH")))).status).toBe(400);

    const up = await (await req(`/api/requirements/${r.id}`, as("editor", json({ title: "電話予約を半分にする", priority: "must", reason: "数値を明確に" }, "PATCH")))).json();
    expect(up).toMatchObject({ code: r.code, title: "電話予約を半分にする", priority: "must", version: 2 });

    const v = await (await req(`/api/requirements/${r.id}/versions`, as("viewer"))).json();
    expect(v.current.version).toBe(2);
    expect(v.history).toHaveLength(1);
    expect(v.history[0]).toMatchObject({ version: 1, title: r.title, changedBy: "u1", changeReason: "数値を明確に" });

    expect((await req(`/api/requirements/${r.id}`, as("editor", { method: "DELETE" }))).status).toBe(204);
    const list = await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json();
    expect(list.map((x: { id: string }) => x.id)).not.toContain(r.id);
    expect((await req(`/api/requirements/${r.id}`, as("editor", json({ title: "y" }, "PATCH")))).status).toBe(404);

    const d2 = await decide(p.id, "もう少し");
    expect(d2.added[0].code).toBe("BR-04"); // BR-01 を消しても番号は詰めない

    const other = (await (await req("/api/orgs", json({ name: "別" }))).json()).id;
    expect((await req(`/api/requirements/${d2.added[0].id}`, as("admin", json({ title: "z" }, "PATCH"), other))).status).toBe(404);
  });

  /* ---------- 非同期実行 ---------- */
  it("非同期: 受け付けて202を返し、進み具合と結果をジョブで取得できる", async () => {
    const p = await project();
    const r = await req(`/api/projects/${p.id}/rounds?async=1`, as("editor", json({ answer: "電話予約を減らしたい" })));
    expect(r.status).toBe(202);
    const { jobId } = await r.json();
    await t.app.jobs.drain();
    const job = await (await req(`/api/jobs/${jobId}`, as("editor"))).json();
    expect(job.status).toBe("done");
    expect(job.result.candidates).toHaveLength(2);
    expect(job.progress.steps.map((s: { label: string; status: string }) => `${s.label}:${s.status}`)).toEqual([
      "Claude役:done",
      "GPT役:done",
      "評価: 評価役:done",
    ]);
    // 他人のジョブは見えない（管理者を除く）
    expect((await req(`/api/jobs/${jobId}`, as("editor", {}, orgId, "u2"))).status).toBe(404);
    expect((await req(`/api/jobs/${jobId}`, as("admin", {}, orgId, "u2"))).status).toBe(200);
  });

  it("非同期: UML生成もジョブで実行できる", async () => {
    const p = await project();
    await decide(p.id);
    const { jobId } = await (await req(`/api/projects/${p.id}/uml/generate?async=1`, as("editor", { method: "POST" }))).json();
    await t.app.jobs.drain();
    const job = await (await req(`/api/jobs/${jobId}`, as("editor"))).json();
    expect(job.status).toBe("done");
    expect(job.result.mode).toBe("compare");
  });

  it("非同期: 失敗したジョブは理由とHTTPステータスを返す", async () => {
    const cr = await (await req(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "openai", model: "m", apiKey: "k" })))).json();
    const p = await (await req(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "x", aiConfig: { mode: "single", generatorIds: [cr.id] } })))).json();
    const { jobId } = await (await req(`/api/projects/${p.id}/rounds?async=1`, as("editor", json({ answer: "a" })))).json();
    await t.app.jobs.drain();
    const job = await (await req(`/api/jobs/${jobId}`, as("editor"))).json();
    expect(job.status).toBe("failed");
    expect(job.errorStatus).toBe(502);
    expect(job.progress.steps[0].status).toBe("failed");
  });

  it("非同期: 組織の上限に達していれば受け付け時点で429", async () => {
    const p = await project();
    await decide(p.id);
    await req(`/api/orgs/${orgId}/limits`, as("admin", json({ monthlyTokenLimit: 1 }, "PUT")));
    expect((await req(`/api/projects/${p.id}/rounds?async=1`, as("editor", json({ answer: "a" })))).status).toBe(429);
  });

  /* ---------- 監査ログ ---------- */
  it("監査ログ: 操作とAIに送った内容を記録し、APIキーは記録しない", async () => {
    const p = await project();
    await decide(p.id, "秘密ではない回答");
    const cr = (await (await req(`/api/orgs/${orgId}/providers`, as("viewer"))).json())[0];
    await req(`/api/orgs/${orgId}/providers/${cr.id}`, as("admin", json({ apiKey: "sk-super-secret-9999" }, "PATCH")));
    await req(`/api/orgs/${orgId}/limits`, as("admin", json({ monthlyTokenLimit: 100000 }, "PUT")));

    expect((await req(`/api/orgs/${orgId}/audit`, as("editor"))).status).toBe(403);
    const { entries } = await (await req(`/api/orgs/${orgId}/audit`, as("admin"))).json();
    const actions = entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["org.create", "provider.create", "project.create", "ai.round", "decision.create", "provider.update", "org.limits.update"]),
    );
    expect(actions[0]).toBe("org.limits.update"); // 新しい順

    const round = entries.find((e: { action: string }) => e.action === "ai.round");
    expect(round.actor).toBe("u1");
    expect(round.detail.sent.answer).toBe("秘密ではない回答");
    expect(round.detail.generators.map((g: { label: string }) => g.label).sort()).toEqual(["Claude役", "GPT役"]);
    expect(round.detail.evaluator.label).toBe("評価役");

    const upd = entries.find((e: { action: string }) => e.action === "provider.update");
    expect(upd.detail.apiKeyChanged).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("sk-super-secret");

    // 絞り込みと続きの取得
    const ai = await (await req(`/api/orgs/${orgId}/audit?action=ai.`, as("admin"))).json();
    expect(ai.entries.every((e: { action: string }) => e.action.startsWith("ai."))).toBe(true);
    const page1 = await (await req(`/api/orgs/${orgId}/audit?limit=2`, as("admin"))).json();
    expect(page1.entries).toHaveLength(2);
    const page2 = await (await req(`/api/orgs/${orgId}/audit?limit=2&before=${page1.next}`, as("admin"))).json();
    expect(page2.entries[0].id).not.toBe(page1.entries[1].id);
  });

  it("監査ログ: 保持期間を過ぎたものを削除できる", async () => {
    expect(await t.store.purgeAudit(new Date(Date.now() + 1000))).toBeGreaterThan(0);
    const { entries } = await (await req(`/api/orgs/${orgId}/audit`, as("admin"))).json();
    expect(entries).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* ログイン（OIDC 認可コード＋PKCE）                                    */
/* ------------------------------------------------------------------ */

describe("ログイン（OIDC）", () => {
  const ISSUER = "https://idp.example.com/realms/arn";
  const CLIENT = "arn-web";

  async function setupOidc() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const sign = (claims: Record<string, unknown>, aud = CLIENT) =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("10m").sign(privateKey);

    const store = new MemoryStore();
    const org = await store.createOrg("組織");
    let nextIdToken = "";
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          jwks_uri: `${ISSUER}/certs`,
          end_session_endpoint: `${ISSUER}/logout`,
        });
      }
      if (String(url).endsWith("/token")) {
        calls.push({ url: String(url), body: String(init?.body) });
        if (String(init?.body).includes("code=bad")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ id_token: nextIdToken, refresh_token: String(init?.body).includes("refresh_token=") ? undefined : "rt-1", expires_in: 300 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const opts = { issuer: ISSUER, audience: CLIENT, orgClaim: "org_id", roleClaim: "roles" };
    const discovery = new OidcDiscoveryCache(`${ISSUER}/.well-known/openid-configuration`, fetchImpl);
    const app = createApp({
      store,
      encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
      storage: new MemoryStorage(),
      authenticate: oidcAuthenticator({ ...opts, keys: createLocalJWKSet({ keys: [jwk] }) }, discovery),
      allowMock: true,
      devAuth: false,
      oidc: { client: new OidcClient(discovery, { clientId: CLIENT, scope: "openid email", fetchImpl }), orgClaim: "org_id", roleClaim: "roles" },
    });
    return { app, store, org, sign, calls, setToken: (tk: string) => (nextIdToken = tk) };
  }

  const verifier = "v".repeat(43);

  it("設定の取得 → コード交換 → IDトークンでAPIを呼べる。ログインは監査ログに残る", async () => {
    const o = await setupOidc();
    const meta = await (await o.app.request("/api/meta")).json();
    expect(meta).toMatchObject({ auth: "oidc", oidc: { orgClaim: "org_id", roleClaim: "roles" } });

    const conf = await (await o.app.request("/api/auth/config")).json();
    expect(conf).toMatchObject({ clientId: CLIENT, scope: "openid email", logoutUrl: `${ISSUER}/logout` });
    expect(conf.authorizationEndpoint).toContain("/auth");

    o.setToken(await o.sign({ sub: "user-1", org_id: o.org.id, roles: ["editor", "admin"] }));
    const tr = await o.app.request("/api/auth/token", json({ code: "c1", codeVerifier: verifier, redirectUri: "http://localhost:8787/" }));
    expect(tr.status).toBe(200);
    const tokens = await tr.json();
    expect(tokens.refreshToken).toBe("rt-1");
    expect(o.calls[0]!.body).toContain("code_verifier=" + verifier);
    expect(o.calls[0]!.body).toContain("grant_type=authorization_code");

    const auth = { headers: { authorization: `Bearer ${tokens.idToken}` } };
    expect((await o.app.request(`/api/orgs/${o.org.id}/providers`, auth)).status).toBe(200);
    const audit = await (await o.app.request(`/api/orgs/${o.org.id}/audit`, auth)).json();
    expect(audit.entries[0]).toMatchObject({ action: "auth.login", actor: "user-1", detail: { role: "admin" } });

    // 更新: Cognito のように refresh_token が返らなくても、元のものを使い続ける
    const rf = await (await o.app.request("/api/auth/refresh", json({ refreshToken: "rt-1" }))).json();
    expect(rf.refreshToken).toBe("rt-1");
  });

  it("別のクライアント向けのトークンや、組織の設定がない利用者は拒否する", async () => {
    const o = await setupOidc();
    const wrongAud = await o.sign({ sub: "u", org_id: o.org.id, roles: ["admin"] }, "other-client");
    expect((await o.app.request(`/api/orgs/${o.org.id}/providers`, { headers: { authorization: `Bearer ${wrongAud}` } })).status).toBe(401);

    o.setToken(await o.sign({ sub: "u2", roles: ["admin"] }));
    const r = await o.app.request("/api/auth/token", json({ code: "c2", codeVerifier: verifier, redirectUri: "http://localhost:8787/" }));
    expect(r.status).toBe(403);

    const bad = await o.app.request("/api/auth/token", json({ code: "bad", codeVerifier: verifier, redirectUri: "http://localhost:8787/" }));
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toContain("invalid_grant");
  });

  it("開発用認証では設定を返さない", async () => {
    const t = setup();
    expect((await t.app.request("/api/auth/config")).status).toBe(404);
  });
});
