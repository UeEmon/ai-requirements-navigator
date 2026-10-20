import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  GeminiProvider,
  PHASES,
  MockProvider,
  OllamaProvider,
  OpenAIProvider,
  runRound,
  type CompletionRequest,
} from "../src/index.js";

function fakeFetch(response: unknown, cap: { bodies: any[] }): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    cap.bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
}

const req: CompletionRequest = { system: "指示", context: "前提", messages: [{ role: "user", content: "回答" }] };

describe("プロンプトのキャッシュ", () => {
  it("Claude: 指示と前提の終わりに印を付け、毎回変わる部分には付けない。入力はキャッシュの分を含む合計にする", async () => {
    const cap = { bodies: [] as any[] };
    const p = new AnthropicProvider(
      { id: "c", vendor: "anthropic", model: "m", apiKey: "sk-test" },
      fakeFetch(
        {
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 5 },
        },
        cap,
      ),
    );
    const r = await p.complete(req);
    const body = cap.bodies[0];
    expect(body.system).toEqual([{ type: "text", text: "指示", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "前提", cache_control: { type: "ephemeral" } },
          { type: "text", text: "回答" },
        ],
      },
    ]);
    expect(r.usage).toEqual({ inputTokens: 910, outputTokens: 5, cachedInputTokens: 900, cacheWriteTokens: 0 });
  });

  it("Claude: 前提がなければ指示だけに印を付ける。1h を選ぶと ttl を付ける", async () => {
    const cap = { bodies: [] as any[] };
    const p = new AnthropicProvider(
      { id: "c", vendor: "anthropic", model: "m", apiKey: "sk-test", cacheTtl: "1h" },
      fakeFetch({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }, cap),
    );
    await p.complete({ system: "指示", messages: [{ role: "user", content: "u" }] });
    expect(cap.bodies[0].system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(cap.bodies[0].messages).toEqual([{ role: "user", content: "u" }]);
  });

  it("ChatGPT: 前提を先頭に置き、同じ指示・前提には同じ prompt_cache_key を付ける。キャッシュの分を読む", async () => {
    const cap = { bodies: [] as any[] };
    const res = { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 2000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1536 } } };
    const p = new OpenAIProvider({ id: "o", vendor: "openai", model: "m", apiKey: "k" }, fakeFetch(res, cap));
    const r = await p.complete(req);
    await p.complete({ ...req, messages: [{ role: "user", content: "別の回答" }] });
    await p.complete({ ...req, context: "別の前提" });
    const [a, b, c] = cap.bodies;
    expect(a.messages).toEqual([
      { role: "system", content: "指示" },
      { role: "user", content: "前提\n\n回答" },
    ]);
    expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
    expect(a.prompt_cache_key).not.toBe(c.prompt_cache_key);
    expect(a.prompt_cache_key).not.toContain("前提");
    expect(r.usage.cachedInputTokens).toBe(1536);
  });

  it("ChatGPT: 互換APIのエンドポイントには prompt_cache_key を送らない", async () => {
    const cap = { bodies: [] as any[] };
    const p = new OpenAIProvider({ id: "o", vendor: "openai", model: "m", apiKey: "k", endpoint: "https://example.test" }, fakeFetch({ choices: [] }, cap));
    await p.complete(req);
    expect(cap.bodies[0].prompt_cache_key).toBeUndefined();
  });

  it("Gemini・ローカルLLM: 前提を先頭に置く。キャッシュの分を読む・モデルをメモリに残す", async () => {
    const g = { bodies: [] as any[] };
    const gem = new GeminiProvider(
      { id: "g", vendor: "gemini", model: "gm", apiKey: "k" },
      fakeFetch({ candidates: [], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 1, cachedContentTokenCount: 2048 } }, g),
    );
    expect((await gem.complete(req)).usage.cachedInputTokens).toBe(2048);
    expect(g.bodies[0].contents[0].parts[0].text).toBe("前提\n\n回答");

    const o = { bodies: [] as any[] };
    await new OllamaProvider({ id: "l", vendor: "ollama", model: "llama" }, fakeFetch({ message: { content: "x" } }, o)).complete(req);
    expect(o.bodies[0].messages[1]).toEqual({ role: "user", content: "前提\n\n回答" });
    expect(o.bodies[0].keep_alive).toBe("30m");
  });

  it("ヒアリング: 生成AIと評価AIに同じ前提（プロジェクト・確定済みの要件）を context で渡し、回答は前提の後ろに置く", async () => {
    const seen: CompletionRequest[] = [];
    const spy = (id: string) => {
      const inner = new MockProvider(id);
      return {
        id, vendor: "mock" as const, model: "mock", label: id, isLocal: false,
        complete: (r: CompletionRequest) => {
          seen.push(r);
          return inner.complete(r);
        },
      };
    };
    await runRound(
      {
        phase: PHASES[0]!,
        projectName: "予約",
        projectPurpose: "電話予約をなくす",
        existingRequirements: [{ code: "BR-01", type: "BR", title: "電話予約を半減する", priority: "must" }],
        userAnswer: "Webで予約したい",
      },
      { generators: [spy("a"), spy("b")], evaluator: spy("e"), random: () => 0.5 },
    );
    expect(seen).toHaveLength(3);
    for (const r of seen) {
      expect(r.context).toContain("BR-01 電話予約を半減する");
      expect(r.context).not.toContain("Webで予約したい");
      expect(r.messages[0]!.content).not.toContain("BR-01");
    }
    expect(new Set(seen.map((r) => r.context)).size).toBe(1);
    expect(seen[0]!.messages[0]!.content).toContain("Webで予約したい");
  });
});
