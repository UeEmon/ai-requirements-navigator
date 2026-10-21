import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  GeminiProvider,
  PHASES,
  MockProvider,
  OllamaProvider,
  OpenAIProvider,
  ROUND_MAX_TOKENS,
  runRound,
  type AIProvider,
} from "../src/index.js";

const ctx = {
  phase: PHASES[0]!,
  projectName: "勤怠",
  projectPurpose: "勤怠管理",
  existingRequirements: [],
  userAnswer: "出勤と退勤を記録したい",
};

function fakeFetch(response: unknown, status = 200, bodies: any[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
}

describe("案の生成の失敗", () => {
  it("すべて失敗したときは、AIごとの理由をエラーの文に含める", async () => {
    const a = new MockProvider("a", () => "了解しました");
    const b = new MockProvider("b", () => "");
    await expect(runRound(ctx, { generators: [a, b] })).rejects.toThrow(/すべてのAIで案の生成に失敗しました（模擬AI \(a\): JSONが見つかりません ／ 模擬AI \(b\): AIの応答が空でした）/);
  });

  it("応答が長さの上限で切れたときは、そう伝える", async () => {
    const truncated: AIProvider = {
      id: "t",
      vendor: "mock",
      model: "m",
      label: "途中で切れるAI",
      isLocal: true,
      complete: async () => ({ text: '{"requirements":[{"title":"出', truncated: true, usage: {}, latencyMs: 1 }),
    };
    await expect(runRound(ctx, { generators: [truncated] })).rejects.toThrow(/途中で切れるAI: 応答が長さの上限で途中で切れました/);
  });

  it("案と評価には十分な出力の上限を渡す", async () => {
    const seen: Array<number | undefined> = [];
    const gen = new MockProvider("g");
    const wrap = (p: AIProvider): AIProvider => ({ ...p, id: p.id, label: p.label, complete: (r) => (seen.push(r.maxTokens), p.complete(r)) });
    await runRound(ctx, { generators: [wrap(gen), wrap(new MockProvider("h"))], evaluator: wrap(new MockProvider("e")) });
    expect(seen).toEqual([ROUND_MAX_TOKENS, ROUND_MAX_TOKENS, ROUND_MAX_TOKENS]);
  });

  it("各AIの「途中で切れた」を読み取る", async () => {
    const key = { apiKey: "sk-test" };
    const claude = new AnthropicProvider({ id: "c", vendor: "anthropic", model: "m", ...key }, fakeFetch({ content: [{ type: "text", text: "{" }], stop_reason: "max_tokens", usage: {} }));
    const gpt = new OpenAIProvider({ id: "o", vendor: "openai", model: "m", ...key }, fakeFetch({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
    const gemini = new GeminiProvider(
      { id: "g", vendor: "gemini", model: "m", ...key },
      fakeFetch({ candidates: [{ content: { parts: [{ text: "考え中", thought: true }, { text: "{" }] }, finishReason: "MAX_TOKENS" }] }),
    );
    const ollama = new OllamaProvider({ id: "l", vendor: "ollama", model: "m" }, fakeFetch({ message: { content: "{" }, done_reason: "length" }));
    const req = { system: "s", messages: [{ role: "user" as const, content: "u" }] };
    for (const p of [claude, gpt, gemini, ollama]) expect((await p.complete(req)).truncated).toBe(true);
    // Gemini の考える過程は答えに含めない
    expect((await gemini.complete(req)).text).toBe("{");
  });

  it("提供元のエラーの本文に含まれるキーらしい文字列は伏せる", async () => {
    const gpt = new OpenAIProvider(
      { id: "o", vendor: "openai", model: "m", apiKey: "sk-test" },
      fakeFetch({ error: { message: "Incorrect API key provided: sk-proj-abcdefghijkl" } }, 401),
    );
    const err = await gpt.complete({ system: "s", messages: [{ role: "user", content: "u" }] }).catch((e) => e as Error);
    expect(err.message).toContain("HTTP 401");
    expect(err.message).not.toContain("abcdefghijkl");
  });

  it("時間内に応答がなければ、そう伝える", async () => {
    const slow = new OpenAIProvider({ id: "o", vendor: "openai", model: "m", apiKey: "sk-test" }, ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("This operation was aborted"))))) as unknown as typeof fetch);
    await expect(runRound(ctx, { generators: [slow], timeoutMs: 10 })).rejects.toThrow(/時間内に応答がありませんでした/);
  });
});

describe("AIが null で返す項目", () => {
  it("ears・rule・説明などが null でも、省略と同じに扱って案にする", async () => {
    const gen = new MockProvider("n", () =>
      JSON.stringify({
        items: [
          { title: "勤怠を記録する", type: "BR", description: null, priority: null, ears: null, rule: null },
          { title: "出勤を打刻できる", type: "FR", ears: { pattern: "event", trigger: "出勤ボタンを押した", state: null, response: "出勤時刻を記録する" } },
        ],
        questions: null,
        notes: null,
      }),
    );
    const res = await runRound(ctx, { generators: [gen] });
    const items = res.candidates[0]!.content.items;
    expect(items[0]).toMatchObject({ title: "勤怠を記録する", description: "", priority: "should" });
    expect(items[0]!.ears).toBeUndefined();
    expect(items[1]!.title).toBe("出勤ボタンを押したとき、システムは、出勤時刻を記録しなければならない。");
  });
});

describe("AIが要件を1件も出さないとき", () => {
  const empty = (q: string[]) => new MockProvider("e", () => JSON.stringify({ items: [], questions: q, notes: "" }));

  it("どのAIも0件なら、失敗ではなく、新しい要件がないことと AI の確認したいことを伝える", async () => {
    const err = await runRound(ctx, { generators: [empty(["退勤の打刻忘れはどう扱いますか？"])] }).catch((e) => e);
    expect(err).toMatchObject({ code: "no_items" });
    expect(err.message).toContain("新しい要件が見つかりませんでした");
    expect(err.message).toContain("退勤の打刻忘れはどう扱いますか？");
  });

  it("ほかのAIが案を出していれば、0件のAIは除いて続ける", async () => {
    const res = await runRound(ctx, { generators: [empty([]), new MockProvider("ok")] });
    expect(res.candidates.map((c) => c.providerId)).toEqual(["ok"]);
    expect(res.failures[0]).toMatchObject({ providerId: "e", reason: "この回答からは新しい要件が見つかりませんでした" });
  });
});

describe("要件の1項目の構造が崩れているとき", () => {
  it("EARS・業務ルールの構造だけを捨て、AIが書いた文で要件として残す（評価の統合案も同じ）", async () => {
    const bad = {
      items: [
        { title: "出勤を打刻できる", type: "FR", ears: { pattern: "event", trigger: "出勤ボタンを押した", response: "" } },
        { title: "残業は月45時間まで", type: "RL", rule: { kind: "constraint", examples: [{ given: "", expected: "" }] } },
      ],
    };
    const gen = new MockProvider("g", () => JSON.stringify(bad));
    const ev = new MockProvider("ev", () =>
      JSON.stringify({ scores: { A: { coverage: 80, accuracy: 80, consistency: 80, feasibility: 80, clarity: 80 } }, comments: {}, recommendedLabel: "A", recommendation: "Aがよい", merged: bad }),
    );
    const res = await runRound(ctx, { generators: [gen], evaluator: ev });
    const items = res.candidates[0]!.content.items;
    expect(items.map((x) => x.title)).toEqual(["出勤を打刻できる", "残業は月45時間まで"]);
    expect(items[0]!.ears).toBeUndefined();
    expect(items[1]!.rule).toBeUndefined();
    expect(res.evaluation?.merged.items.map((x) => x.title)).toEqual(["出勤を打刻できる", "残業は月45時間まで"]);
  });
});
