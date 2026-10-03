import { describe, expect, it } from "vitest";
import { KeyCheckError, listModels, redactSecrets } from "../src/index.js";

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fake = (handler: (url: string, headers: Headers) => Response) => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const f = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    seen.push({ url: String(u), headers: h });
    return handler(String(u), h);
  }) as typeof fetch;
  return { f, seen };
};

describe("モデル一覧の取得（キーの確認）", () => {
  it("Claude: x-api-key と anthropic-version で一覧を取る", async () => {
    const { f, seen } = fake(() => res(200, { data: [{ id: "claude-a-1", display_name: "Claude A" }] }));
    expect(await listModels("anthropic", { apiKey: "sk-ant-x" }, f)).toEqual([{ id: "claude-a-1", name: "Claude A" }]);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(seen[0]!.headers.get("x-api-key")).toBe("sk-ant-x");
    expect(seen[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("ChatGPT: チャットに使うモデルだけを新しい順に。互換サーバーではそのまま", async () => {
    const data = { data: [{ id: "gpt-a", created: 1 }, { id: "gpt-b", created: 5 }, { id: "o9-mini", created: 3 }, { id: "gpt-a-realtime", created: 9 }, { id: "text-embedding-x", created: 9 }, { id: "whisper-1", created: 2 }] };
    const { f, seen } = fake(() => res(200, data));
    expect((await listModels("openai", { apiKey: "sk-proj-x" }, f)).map((m) => m.id)).toEqual(["gpt-b", "o9-mini", "gpt-a"]);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk-proj-x");
    expect((await listModels("openai", { apiKey: "k", endpoint: "https://llm.example.com/" }, f)).length).toBe(6);
    expect(seen[1]!.url).toBe("https://llm.example.com/v1/models");
  });

  it("Gemini: generateContent に対応した gemini のモデルだけ。ページをたどる", async () => {
    const { f, seen } = fake((u) =>
      u.includes("pageToken")
        ? res(200, { models: [{ name: "models/gemini-b", displayName: "B", supportedGenerationMethods: ["generateContent"] }] })
        : res(200, { models: [{ name: "models/gemini-a", displayName: "A", supportedGenerationMethods: ["generateContent", "countTokens"] }, { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "p2" }),
    );
    expect(await listModels("gemini", { apiKey: "AIzaX" }, f)).toEqual([{ id: "gemini-a", name: "A" }, { id: "gemini-b", name: "B" }]);
    expect(seen[0]!.headers.get("x-goog-api-key")).toBe("AIzaX");
    expect(seen).toHaveLength(2);
  });

  it("エラーは理由ごとの分かる言葉にし、キーの一部を出さない", async () => {
    const cases: Array<[number, string]> = [[401, "auth"], [403, "permission"], [429, "billing"], [404, "notfound"], [500, "other"]];
    for (const [status, reason] of cases) {
      const { f } = fake(() => res(status, { error: { message: "Incorrect API key provided: sk-proj-ABCDEFGH1234" } }));
      try {
        await listModels("openai", { apiKey: "sk-proj-ABCDEFGH1234" }, f);
        expect("not thrown").toBe("thrown");
      } catch (e) {
        expect(e instanceof KeyCheckError).toBe(true);
        expect((e as KeyCheckError).reason).toBe(reason);
        expect((e as Error).message).not.toContain("ABCDEFGH");
      }
    }
    const net = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    try {
      await listModels("ollama", { endpoint: "http://ollama:11434" }, net);
    } catch (e) {
      expect((e as KeyCheckError).reason).toBe("network");
    }
  });

  it("キーらしい文字列を伏せる", () => {
    expect(redactSecrets("key sk-proj-abcdef123 and AIzaSyABCDEFGHIJKL and ya29.tok-en")).toBe("key sk-… and AIza… and ya29.…");
  });
});
