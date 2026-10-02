import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  detectAmbiguity,
  extractJson,
  GeminiProvider,
  getPhase,
  MockProvider,
  OllamaProvider,
  OpenAIProvider,
  RoundError,
  runRound,
  toMermaidUseCase,
  weightedTotal,
  type PromptContext,
} from "../src/index.js";

const ctx: PromptContext = {
  phase: getPhase("flow"),
  projectName: "美容室のWeb予約システム",
  projectPurpose: "電話予約の負担を減らす",
  existingRequirements: [],
  userAnswer: "予約→前日にリマインド→来店→施術→会計",
};

/** 固定の乱数（並び順を再現可能にする） */
const fixedRandom = () => 0.3;

describe("runRound", () => {
  it("複数AIの案を匿名化して評価し、合計点を重みから計算する", async () => {
    const gens = [new MockProvider("claude"), new MockProvider("gpt"), new MockProvider("gemini")];
    const res = await runRound(ctx, { generators: gens, evaluator: new MockProvider("judge"), random: fixedRandom });

    expect(res.candidates.map((c) => c.label)).toEqual(["A", "B", "C"]);
    expect(new Set(res.candidates.map((c) => c.providerId))).toEqual(new Set(["claude", "gpt", "gemini"]));
    expect(res.evaluation).toBeDefined();
    for (const c of res.candidates) {
      const s = res.evaluation!.scores[c.label]!;
      expect(res.evaluation!.totals[c.label]).toBe(weightedTotal(s));
    }
    expect(res.evaluation!.merged.items.length).toBeGreaterThan(0);
    expect(res.warnings).toEqual([]);
  });

  it("進み具合を通知する", async () => {
    const ev: string[] = [];
    const bad = new MockProvider("bad", () => "x");
    await runRound(ctx, {
      generators: [new MockProvider("claude"), bad],
      evaluator: new MockProvider("judge"),
      onProgress: (e) => ev.push(`${e.type}:${e.providerId}:${e.status}`),
    });
    expect(ev).toEqual(
      expect.arrayContaining(["generator:claude:running", "generator:claude:done", "generator:bad:failed", "evaluator:judge:running", "evaluator:judge:done"]),
    );
    expect(ev.at(-1)).toBe("evaluator:judge:done");
  });

  it("評価AIのプロンプトに生成AIの名前を含めない", async () => {
    let evalPrompt = "";
    const judge = new MockProvider("judge", async (req) => {
      evalPrompt = req.messages[0]!.content;
      return (await new MockProvider("judge").complete(req)).text;
    });
    await runRound(ctx, { generators: [new MockProvider("claude"), new MockProvider("gpt")], evaluator: judge });
    expect(evalPrompt).toContain("### 案A");
    expect(evalPrompt).not.toMatch(/claude|gpt/i);
  });

  it("1つのAIが失敗しても残りの案で続行する", async () => {
    const broken = new MockProvider("broken", () => {
      throw new Error("timeout");
    });
    const res = await runRound(ctx, {
      generators: [new MockProvider("claude"), broken],
      evaluator: new MockProvider("judge"),
    });
    expect(res.candidates).toHaveLength(1);
    expect(res.failures).toEqual([{ providerId: "broken", reason: "timeout" }]);
    expect(res.warnings.some((w) => w.includes("1件のAI"))).toBe(true);
  });

  it("不正なJSONを返した案は失敗として扱う", async () => {
    const bad = new MockProvider("bad", () => "了解しました！");
    const res = await runRound(ctx, { generators: [new MockProvider("claude"), bad] });
    expect(res.failures.map((f) => f.providerId)).toEqual(["bad"]);
  });

  it("すべて失敗したら RoundError(all_failed)", async () => {
    const bad = new MockProvider("bad", () => "no json");
    await expect(runRound(ctx, { generators: [bad] })).rejects.toMatchObject({ code: "all_failed" });
  });

  it("評価AIが生成AIに含まれると警告する", async () => {
    const claude = new MockProvider("claude");
    const res = await runRound(ctx, { generators: [claude, new MockProvider("gpt")], evaluator: claude });
    expect(res.warnings[0]).toContain("評価AIが生成AIにも含まれています");
  });

  it("機密プロジェクトでは社外AIを拒否し、ローカルAIは許可する", async () => {
    await expect(
      runRound(ctx, { generators: [new MockProvider("cloud")], confidential: true }),
    ).rejects.toBeInstanceOf(RoundError);
    const local = new MockProvider("local", undefined, { isLocal: true });
    const res = await runRound(ctx, { generators: [local], confidential: true });
    expect(res.candidates).toHaveLength(1);
  });

  it("時間切れのAIは中断し、失敗として扱う", async () => {
    const slow = new MockProvider(
      "slow",
      (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const res = await runRound(ctx, { generators: [new MockProvider("fast"), slow], timeoutMs: 50 });
    expect(res.failures).toEqual([{ providerId: "slow", reason: "aborted" }]);
  });
});

describe("providers", () => {
  const fakeFetch = (reply: unknown, capture: { url?: string; init?: RequestInit } = {}) =>
    (async (url: string, init: RequestInit) => {
      capture.url = url;
      capture.init = init;
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;

  it("Anthropic: ヘッダーと応答の解析", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const p = new AnthropicProvider(
      { id: "c", vendor: "anthropic", model: "m", apiKey: "sk-test" },
      fakeFetch({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } }, cap),
    );
    const r = await p.complete({ system: "s", messages: [{ role: "user", content: "u" }] });
    expect(r.text).toBe("hi");
    expect(cap.url).toBe("https://api.anthropic.com/v1/messages");
    expect((cap.init!.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
  });

  it("OpenAI: JSONモードとsystemメッセージ", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const p = new OpenAIProvider(
      { id: "o", vendor: "openai", model: "m", apiKey: "k" },
      fakeFetch({ choices: [{ message: { content: "{}" } }] }, cap),
    );
    await p.complete({ system: "s", messages: [{ role: "user", content: "u" }], json: true });
    const body = JSON.parse(String(cap.init!.body));
    expect(body.messages[0]).toEqual({ role: "system", content: "s" });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("Gemini: assistant を model ロールに変換", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const p = new GeminiProvider(
      { id: "g", vendor: "gemini", model: "gm", apiKey: "k" },
      fakeFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }, cap),
    );
    const r = await p.complete({
      system: "s",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    });
    expect(r.text).toBe("ok");
    expect(JSON.parse(String(cap.init!.body)).contents[1].role).toBe("model");
    expect(cap.url).toContain("/v1beta/models/gm:generateContent");
  });

  it("Ollama: ローカル扱いでAPIキー不要", async () => {
    const p = new OllamaProvider({ id: "l", vendor: "ollama", model: "llama" }, fakeFetch({ message: { content: "x" } }));
    expect(p.isLocal).toBe(true);
    expect((await p.complete({ system: "s", messages: [] })).text).toBe("x");
  });

  it("HTTPエラーは ProviderError になる", async () => {
    const f = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const p = new OpenAIProvider({ id: "o", vendor: "openai", model: "m", apiKey: "k" }, f);
    await expect(p.complete({ system: "s", messages: [] })).rejects.toMatchObject({ status: 401 });
  });
});

describe("utilities", () => {
  it("extractJson: コードフェンスと前置きを除去", () => {
    expect(extractJson('はい。\n```json\n{"a":"}"}\n```')).toEqual({ a: "}" });
  });

  it("detectAmbiguity: 曖昧な表現を検出", () => {
    const hits = detectAmbiguity("なるべく速い画面でたくさん表示");
    expect(hits.map((h) => h.term)).toEqual(["なるべく", "速い", "たくさん"]);
  });

  it("toMermaidUseCase: 利用者と機能要件から図を作る", () => {
    const src = toMermaidUseCase("予約", [
      { code: "AC-01", type: "AC", title: "店長：シフトを管理" },
      { code: "FR-01", type: "FR", title: "店長はシフトを登録する" },
    ]);
    expect(src).toContain('A0(["店長"])');
    expect(src).toContain("A0 --- U0");
  });
});
