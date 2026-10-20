import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** 提供元のモデル一覧だけを返す偽の fetch（Gemini はキーが無効、という想定） */
function setup() {
  const store = new MemoryStore();
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).startsWith("https://api.anthropic.com/v1/models"))
      return res({ data: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }, { id: "claude-3-5-haiku-20241022" }] });
    if (String(url).startsWith("https://api.openai.com/v1/models"))
      return res({ data: [{ id: "gpt-5", created: 3 }, { id: "gpt-5-mini", created: 2 }, { id: "gpt-5-nano", created: 1 }, { id: "gpt-realtime", created: 4 }] });
    if (String(url).endsWith("/api/tags")) return res({ models: [{ name: "llama3.1:70b" }, { name: "qwen2.5:14b" }, { name: "nomic-embed-text" }] });
    if (String(url).includes("generativelanguage")) return res({ error: { message: "API key not valid: AIzaSECRETSECRET1234" } }, 401);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const app = createApp({
    store,
    encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
    storage: new MemoryStorage(),
    authenticate: devAuthenticator,
    allowMock: true,
    devAuth: true,
    fetchImpl: fakeFetch,
  });
  return { app, store, calls };
}
const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("おすすめの組み合わせ（各AIのモデル一覧から）", () => {
  it("登録済みのキーで一覧を取り、系統ごとの代表を未登録の候補に加える。選んだモデルは同じキーで登録できる", async () => {
    const { app, store, calls } = setup();
    const orgId = (await (await app.request("/api/orgs", json({ name: "組織" }))).json()).id;
    const as = (role: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role } });
    const add = async (b: Record<string, unknown>) => (await (await app.request(`/api/orgs/${orgId}/providers`, as("admin", json(b)))).json()).id as string;
    const claude = await add({ vendor: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-aaaa1111" });
    await add({ vendor: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-aaaa1111" });
    await add({ vendor: "openai", model: "gpt-5-mini", apiKey: "sk-proj-bbbb2222" });
    await add({ vendor: "gemini", model: "gemini-2.5-pro", apiKey: "AIzaSECRETSECRET1234" });
    await add({ vendor: "ollama", model: "llama3.1:70b" });
    await add({ vendor: "mock", model: "mock" });

    // 既定は登録済みのAIだけ（外部に問い合わせない）
    const plain = await (await app.request(`/api/orgs/${orgId}/ai-advice`, as("viewer"))).json();
    expect(plain.profiles.every((p: { unregistered?: boolean }) => !p.unregistered)).toBe(true);
    expect(calls).toEqual([]);
    // 候補は、キーを設定した標準の AI とローカルLLM だけ（模擬AIは外す）
    expect(plain.profiles.map((p: { vendor: string }) => p.vendor).sort()).toEqual(["anthropic", "anthropic", "gemini", "ollama", "openai"]);
    expect(plain.notes.join("")).toContain("模擬AI");

    const a = await (await app.request(`/api/orgs/${orgId}/ai-advice?catalog=1`, as("viewer"))).json();
    // 同じキーの Claude は1回だけ一覧を取る
    expect(calls.filter((u) => u.includes("anthropic"))).toHaveLength(1);
    const un = a.profiles.filter((p: { unregistered?: boolean }) => p.unregistered).map((p: { model: string }) => p.model).sort();
    // 登録済み（sonnet・haiku・gpt-5-mini・llama3.1:70b）は除き、古い Haiku・音声・埋め込みのモデルは候補にしない。ローカルLLM は取り込んだものすべて
    expect(un).toEqual(["claude-opus-5-5", "gpt-5", "gpt-5-nano", "qwen2.5:14b"]);
    // 取れた一覧は覚えておき、もう一度開いても問い合わせない（取れなかった Gemini だけ問い合わせ直す）
    const n = calls.length;
    await app.request(`/api/orgs/${orgId}/ai-advice?catalog=1`, as("viewer"));
    expect(calls.slice(n).map((u) => new URL(u).hostname)).toEqual(["generativelanguage.googleapis.com"]);
    expect(a.notes.join("")).toContain("モデルの一覧を取れませんでした");
    expect(JSON.stringify(a)).not.toMatch(/SECRET|aaaa1111|bbbb2222/);
    const quality = a.review.find((c: { goals: string[] }) => c.goals.includes("quality"));
    expect(quality.cautions.join("")).toContain("まだ登録していない");

    // 未登録のモデルを登録する（キーは元の AI のものを使う。管理者だけ）
    const opus = a.profiles.find((p: { model: string }) => p.model === "claude-opus-5-5");
    expect(opus.sourceId).toBe(claude);
    expect((await app.request(`/api/orgs/${orgId}/providers/${claude}/copy`, as("editor", json({ model: "claude-opus-5-5" })))).status).toBe(403);
    const r = await app.request(`/api/orgs/${orgId}/providers/${claude}/copy`, as("admin", json({ model: "claude-opus-5-5" })));
    expect(r.status).toBe(201);
    const created = await r.json();
    expect(created).toMatchObject({ vendor: "anthropic", model: "claude-opus-5-5", label: "Claude (claude-opus-5-5)" });
    const creds = await store.listCredentials(orgId);
    expect(creds.find((x) => x.id === created.id)!.encryptedKey).toBe(creds.find((x) => x.id === claude)!.encryptedKey);
    const logs = await store.listAudit(orgId, { limit: 10 });
    expect(logs.find((l) => l.targetId === created.id)?.detail).toMatchObject({ copiedFrom: { id: claude } });
  });
});
