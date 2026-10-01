import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore, type Store } from "../src/store.js";

export function makeApp(store: Store = new MemoryStore()) {
  const encryptor = new LocalKeyEncryptor(randomBytes(32).toString("base64"));
  const storage = new MemoryStorage();
  // 外部AIへの通信はテストでは偽の応答を返す
  const fakeFetch = (async (url: string) => {
    if (String(url).includes("anthropic")) {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ items: [{ title: "本物APIからの案", type: "FR" }] }) }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const app = createApp({
    store,
    encryptor,
    storage,
    authenticate: devAuthenticator,
    allowMock: true,
    devAuth: true,
    fetchImpl: fakeFetch,
    random: () => 0.5,
  });
  return { app, store, storage, encryptor };
}

const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("API", () => {
  let t: ReturnType<typeof makeApp>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, org = orgId) => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-org-id": org, "x-role": role },
  });

  beforeEach(async () => {
    t = makeApp();
    const res = await t.app.request("/api/orgs", json({ name: "テスト組織" }));
    expect(res.status).toBe(201);
    orgId = (await res.json()).id;
  });

  async function registerMocks() {
    const ids: string[] = [];
    for (const label of ["Claude役", "GPT役", "評価役"]) {
      const r = await t.app.request(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label })));
      expect(r.status).toBe(201);
      ids.push((await r.json()).id);
    }
    return ids;
  }

  it("APIキーは管理者だけが登録でき、暗号化して保存され、末尾4桁だけ返る", async () => {
    const denied = await t.app.request(
      `/api/orgs/${orgId}/providers`,
      as("editor", json({ vendor: "anthropic", model: "m", apiKey: "sk-secret-1234" })),
    );
    expect(denied.status).toBe(403);

    const ok = await t.app.request(
      `/api/orgs/${orgId}/providers`,
      as("admin", json({ vendor: "anthropic", model: "m", apiKey: "sk-secret-1234" })),
    );
    expect(ok.status).toBe(201);
    const pub = await ok.json();
    expect(pub.apiKey).toBe("••••1234");
    expect(JSON.stringify(pub)).not.toContain("sk-secret");

    const [saved] = await t.store.listCredentials(orgId);
    expect(saved!.encryptedKey).not.toContain("sk-secret");
    expect(await t.encryptor.decrypt(saved!.encryptedKey!, { orgId })).toBe("sk-secret-1234");
    // 別の組織IDでは復号できない（AAD）
    await expect(t.encryptor.decrypt(saved!.encryptedKey!, { orgId: "other" })).rejects.toThrow();
  });

  it("クラウドAIはAPIキー必須", async () => {
    const r = await t.app.request(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "openai", model: "m" })));
    expect(r.status).toBe(400);
  });

  it("他の組織のデータは見えない", async () => {
    const other = (await (await t.app.request("/api/orgs", json({ name: "別組織" }))).json()).id;
    const r = await t.app.request(`/api/orgs/${orgId}/providers`, as("admin", {}, other));
    expect(r.status).toBe(404);
  });

  it("未ログインは401", async () => {
    expect((await t.app.request(`/api/orgs/${orgId}/providers`)).status).toBe(401);
  });

  it("複数AIで生成→匿名で評価→決定→要件・仕様書に反映", async () => {
    const [g1, g2, ev] = await registerMocks();
    const pr = await t.app.request(
      `/api/orgs/${orgId}/projects`,
      as("editor", json({ name: "予約システム", purpose: "電話予約を減らす", aiConfig: { mode: "multi", generatorIds: [g1, g2], evaluatorId: ev } })),
    );
    expect(pr.status).toBe(201);
    const project = await pr.json();
    expect(project.phaseKey).toBe("purpose");

    const rr = await t.app.request(`/api/projects/${project.id}/rounds`, as("editor", json({ answer: "なるべく早く電話を減らしたい" })));
    expect(rr.status).toBe(201);
    const round = await rr.json();
    expect(round.candidates.map((c: { label: string }) => c.label)).toEqual(["A", "B"]);
    expect(JSON.stringify(round.candidates)).not.toContain(g1); // 提供元を伏せる
    expect(round.evaluation.totals.A).toBeTypeOf("number");
    expect(round.evaluation.merged.items.length).toBeGreaterThan(0);
    expect(round.ambiguity.map((h: { term: string }) => h.term)).toEqual(["なるべく", "早く"]);

    const dr = await t.app.request(`/api/rounds/${round.id}/decision`, as("editor", json({ pick: "merged", itemIndexes: [0, 1], reason: "抜けが少ない" })));
    expect(dr.status).toBe(201);
    const decision = await dr.json();
    expect(decision.added.map((r: { code: string }) => r.code)).toEqual(["BR-01", "BR-02"]);
    expect(Object.values(decision.mapping).sort()).toEqual(["Claude役", "GPT役"]);
    expect(decision.nextPhase).toBe("actors");

    const again = await t.app.request(`/api/rounds/${round.id}/decision`, as("editor", json({ pick: "A" })));
    expect(again.status).toBe(409);

    const spec = await (await t.app.request(`/api/projects/${project.id}/spec.md`, as("viewer"))).text();
    expect(spec).toContain("# 予約システム 要件定義書");
    expect(spec).toContain("| BR-01 |");
    expect(spec).toContain("```mermaid");

    const ex = await t.app.request(`/api/projects/${project.id}/exports`, as("editor", { method: "POST" }));
    expect(ex.status).toBe(201);
    expect(t.storage.files.size).toBe(1);

    const usage = await (await t.app.request(`/api/orgs/${orgId}/usage`, as("admin"))).json();
    expect(usage).toHaveLength(3); // 生成2 + 評価1
  });

  it("閲覧者は生成できない", async () => {
    const [g1] = await registerMocks();
    const project = await (
      await t.app.request(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "x", aiConfig: { mode: "single", generatorIds: [g1] } })))
    ).json();
    const r = await t.app.request(`/api/projects/${project.id}/rounds`, as("viewer", json({ answer: "a" })));
    expect(r.status).toBe(403);
  });

  it("登録したAnthropicの接続情報で実際のAPI形式に従って呼び出す", async () => {
    const cr = await (
      await t.app.request(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "anthropic", model: "m", apiKey: "sk-xxxx9999" })))
    ).json();
    const project = await (
      await t.app.request(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "x", aiConfig: { mode: "single", generatorIds: [cr.id] } })))
    ).json();
    const round = await (await t.app.request(`/api/projects/${project.id}/rounds`, as("editor", json({ answer: "a" })))).json();
    expect(round.candidates[0].content.items[0].title).toBe("本物APIからの案");
    expect(round.evaluation).toBeNull();
  });

  it("機密プロジェクトではクラウドAIを選べない", async () => {
    const [g1] = await registerMocks();
    const r = await t.app.request(
      `/api/orgs/${orgId}/projects`,
      as("editor", json({ name: "x", confidential: true, aiConfig: { mode: "single", generatorIds: [g1] } })),
    );
    expect(r.status).toBe(400);
  });

  it("全AIが失敗したら502", async () => {
    const cr = await (
      await t.app.request(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "openai", model: "m", apiKey: "k" })))
    ).json();
    const project = await (
      await t.app.request(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "x", aiConfig: { mode: "single", generatorIds: [cr.id] } })))
    ).json();
    const r = await t.app.request(`/api/projects/${project.id}/rounds`, as("editor", json({ answer: "a" })));
    expect(r.status).toBe(502);
  });
});
