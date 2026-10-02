import { describe, expect, it } from "vitest";
import { defaultGuide, findGlossary, generateGuide, getPhase, MockProvider, type GuideContext } from "../src/index.js";

const ctx = (n: number): GuideContext => ({
  phase: getPhase("quality"),
  projectName: "予約",
  projectPurpose: "",
  phaseRequirements: Array.from({ length: n }, (_, i) => ({ code: `NFR-0${i + 1}`, title: `要件${i}` })),
  otherRequirements: [{ code: "FR-01", title: "予約できる" }],
});

describe("質問ガイド", () => {
  it("AIが観点の網羅状況を判定し、足りない観点の質問・候補・用語解説を返す", async () => {
    const { guide, failures } = await generateGuide([new MockProvider("g")], ctx(2));
    expect(failures).toEqual([]);
    expect(guide.source).toBe("ai");
    expect(guide.covered).toEqual(["性能", "可用性"]);
    expect(guide.missing).toEqual(["セキュリティ", "使いやすさ", "運用・保守"]);
    expect(guide.coverage).toBeCloseTo(0.4);
    expect(guide.question).toContain("セキュリティ");
    expect(guide.options.length).toBeGreaterThan(0);
    // AIの解説と標準の用語集（「応答時間」）の両方を含む
    expect(guide.glossary.map((g) => g.term)).toEqual(expect.arrayContaining(["担当者", "応答時間"]));
    expect(guide.requirementCount).toBe(2);
  });

  it("チェックリストにない観点は無視する", async () => {
    const odd = new MockProvider("odd", () => JSON.stringify({ question: "q", coveredPoints: ["性能", "存在しない観点"] }));
    const { guide } = await generateGuide([odd], ctx(0));
    expect(guide.covered).toEqual(["性能"]);
  });

  it("AIが失敗したら次のAI、すべて失敗したら既定の質問を返す", async () => {
    const bad = new MockProvider("bad", () => "了解");
    const r1 = await generateGuide([bad, new MockProvider("ok")], ctx(0));
    expect(r1.guide.providerId).toBe("ok");
    const r2 = await generateGuide([bad], ctx(0));
    expect(r2.guide.source).toBe("default");
    expect(r2.guide.question).toBe(getPhase("quality").question);
    expect(r2.guide.options).toEqual(getPhase("quality").defaultOptions);
    expect(r2.failures).toHaveLength(1);
  });

  it("既定のガイドでも用語解説をつける", () => {
    const g = defaultGuide(ctx(0));
    expect(g.coverage).toBe(0);
    expect(findGlossary(["非機能要件と要件"]).map((x) => x.term)).toEqual(["非機能要件", "要件"]);
  });
});
