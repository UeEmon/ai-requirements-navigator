import { describe, expect, it } from "vitest";
import { comboAxes, modelProfile, pickCatalogModels, recommendModelCombos, type AdviceProvider } from "../src/index.js";

const ai = (id: string, vendor: AdviceProvider["vendor"], model: string): AdviceProvider => ({ id, vendor, model, label: id, isLocal: vendor === "ollama" });

describe("モデルの性格の目安", () => {
  it("モデル名の系統から、速さ・推論力・消費を推定する", () => {
    const haiku = modelProfile("anthropic", "claude-haiku-5-5");
    const opus = modelProfile("anthropic", "claude-opus-5-5");
    expect(haiku.speed).toBeGreaterThan(opus.speed);
    expect(opus.depth).toBeGreaterThan(haiku.depth);
    expect(opus.cost).toBeGreaterThan(haiku.cost);
    expect(modelProfile("openai", "gpt-5-nano").cost).toBe(1);
    expect(modelProfile("openai", "o3-pro").depth).toBe(5);
    expect(modelProfile("openai", "gpt-4o-mini").family).toContain("mini");
    expect(modelProfile("gemini", "gemini-2.5-flash-lite").speed).toBe(5);
    expect(modelProfile("gemini", "gemini-2.5-pro").depth).toBe(5);
    expect(modelProfile("ollama", "llama3.1:70b").depth).toBeGreaterThan(modelProfile("ollama", "llama3.2:3b").depth);
  });

  it("推定できない名前は普通として扱い、その旨を伝える", () => {
    const x = modelProfile("openai", "my-company-model");
    expect([x.speed, x.depth, x.cost]).toEqual([3, 3, 3]);
    expect(x.family).toBeNull();
    expect(x.notes[0]).toContain("推定できなかった");
  });

  it("単独AI＋評価AI: 待ち時間は2つの合計、深さと消費は評価AIを重く見る", () => {
    const fast = modelProfile("gemini", "gemini-2.5-flash-lite");
    const deep = modelProfile("anthropic", "claude-opus-5-5");
    const a = comboAxes(fast, deep);
    expect(a.speed.level).toBeLessThan(fast.speed);
    expect(a.depth.level).toBeGreaterThanOrEqual(4);
    expect(comboAxes(deep, fast).depth.level).toBeLessThan(a.depth.level);
  });
});

describe("おすすめの組み合わせ", () => {
  const providers = [
    ai("haiku", "anthropic", "claude-haiku-5-5"),
    ai("sonnet", "anthropic", "claude-sonnet-5-5"),
    ai("opus", "anthropic", "claude-opus-5-5"),
    ai("mini", "openai", "gpt-5-mini"),
    ai("flash", "gemini", "gemini-2.5-flash"),
    ai("pro", "gemini", "gemini-2.5-pro"),
  ];

  it("目的ごとに生成AIと評価AIの組を出す。評価AIは生成AIと別で、提供元も違うものを選ぶ", () => {
    const r = recommendModelCombos(providers);
    const goals = r.review.flatMap((c) => c.goals);
    expect(goals.sort()).toEqual(["balanced", "fast", "quality"]);
    for (const c of r.review) {
      expect(c.evaluatorId).not.toBe(c.generatorId);
      const g = providers.find((x) => x.id === c.generatorId)!, e = providers.find((x) => x.id === c.evaluatorId)!;
      expect(g.vendor).not.toBe(e.vendor);
      expect(c.reasons.length).toBeGreaterThan(0);
    }
    const quality = r.review.find((c) => c.goals.includes("quality"))!;
    const fast = r.review.find((c) => c.goals.includes("fast"))!;
    expect(quality.axes.depth.level).toBeGreaterThanOrEqual(fast.axes.depth.level);
    expect(fast.axes.speed.level).toBeGreaterThanOrEqual(quality.axes.speed.level);
    expect(fast.axes.cost.level).toBeLessThanOrEqual(quality.axes.cost.level);
    // 品質を優先するなら、評価AIは推論力の高いモデル
    expect(["opus", "pro"]).toContain(quality.evaluatorId);
    // 単一AIの提案も出す
    expect(r.single.flatMap((c) => c.goals).sort()).toEqual(["balanced", "fast", "quality"]);
    expect(r.notes.at(-1)).toContain("あなたが決めて");
  });

  it("複数AI＋評価AI: 生成AIは2つで提供元を分け、評価AIはどちらとも別にする", () => {
    const r = recommendModelCombos(providers);
    expect(r.multi.flatMap((c) => c.goals).sort()).toEqual(["balanced", "fast", "quality"]);
    for (const c of r.multi) {
      expect(c.mode).toBe("multi");
      expect(c.generatorIds).toHaveLength(2);
      expect(c.generatorIds).not.toContain(c.evaluatorId);
      const [a, b] = c.generatorIds.map((id) => providers.find((x) => x.id === id)!.vendor);
      expect(a).not.toBe(b);
    }
    const quality = r.multi.find((c) => c.goals.includes("quality"))!;
    const fast = r.multi.find((c) => c.goals.includes("fast"))!;
    expect(quality.axes.depth.level).toBeGreaterThanOrEqual(fast.axes.depth.level);
    expect(fast.axes.cost.level).toBeLessThanOrEqual(quality.axes.cost.level);
    expect(quality.cautions.join("")).toContain("トークンの消費が多く");
    // AI が2つなら、評価AI を別にできないため提案しない
    const two = recommendModelCombos(providers.slice(0, 2));
    expect(two.multi).toEqual([]);
    expect(two.notes.join("")).toContain("3つの AI が必要");
  });

  it("AI が1つだけなら、単独AI＋評価AI は提案せず理由を伝える", () => {
    const r = recommendModelCombos([ai("only", "anthropic", "claude-sonnet-5-5")]);
    expect(r.review).toEqual([]);
    expect(r.single).toHaveLength(1);
    expect(r.single[0]!.goals).toHaveLength(3);
    expect(r.notes[0]).toContain("もう1つ必要");
  });

  it("同じ提供元だけなら、そのことを注意として伝える", () => {
    const r = recommendModelCombos(providers.filter((x) => x.vendor === "anthropic"));
    expect(r.review.length).toBeGreaterThan(0);
    expect(r.review[0]!.cautions.join("")).toContain("同じ提供元");
    expect(r.notes.join("")).toContain("すべて同じ提供元");
  });

  it("機密プロジェクトでは、ローカルLLMだけから選ぶ", () => {
    const r = recommendModelCombos([...providers, ai("llama", "ollama", "llama3.1:70b")], { confidential: true });
    expect(r.profiles.map((x) => x.id)).toEqual(["llama"]);
    expect(r.single[0]!.generatorId).toBe("llama");
    expect(recommendModelCombos(providers, { confidential: true }).notes[0]).toContain("ローカルLLM");
  });
});

describe("各AIのモデル一覧から候補を選ぶ", () => {
  it("系統ごとに、新しい正式版を1つ選ぶ。音声・画像・実験用・系統の分からないものは除く", () => {
    expect(pickCatalogModels("anthropic", ["claude-opus-4-1-20250805", "claude-opus-5-5", "claude-3-5-haiku-20241022", "claude-haiku-5-5", "claude-sonnet-5-5"]).sort()).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(pickCatalogModels("openai", ["gpt-5", "gpt-5-chat-latest", "gpt-4o-mini-2024-07-18", "gpt-5-mini", "gpt-realtime", "gpt-5-codex", "chatgpt-4o-latest"]).sort()).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(pickCatalogModels("gemini", ["gemini-2.5-flash", "gemini-2.5-flash-preview-05-20", "gemini-2.5-flash-image", "gemini-2.0-flash-exp", "gemini-3-pro-preview", "gemini-2.5-pro"]).sort()).toEqual([
      "gemini-2.5-flash",
      "gemini-3-pro-preview",
    ]);
    // ローカルLLM は取り込んだものすべて（埋め込み用は除く）。模擬AI は候補にしない
    expect(pickCatalogModels("ollama", ["llama3.1:70b", "gemma3:12b", "nomic-embed-text"])).toEqual(["llama3.1:70b", "gemma3:12b"]);
    expect(pickCatalogModels("mock", ["mock"])).toEqual([]);
  });
});
