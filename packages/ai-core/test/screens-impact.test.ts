import { describe, expect, it } from "vitest";
import {
  analyzeImpact,
  buildImpactReport,
  classifyScreenFeedback,
  generateScreens,
  MockProvider,
  renderPrototypeHtml,
  screenFlowMermaid,
  type ChangeProposal,
  type ImpactContext,
} from "../src/index.js";

const reqs = [
  { code: "BR-01", type: "BR", title: "電話予約を減らす" },
  { code: "FR-01", type: "FR", title: "予約を登録できる" },
  { code: "FR-02", type: "FR", title: "予約を取り消せる" },
  { code: "FR-03", type: "FR", title: "空き枠を確認できる" },
  { code: "NFR-01", type: "NFR", title: "3秒以内に表示する" },
];

describe("画面設計・プロトタイプ", () => {
  it("要件から画面一覧を作り、見た目の項目・存在しない遷移を捨て、機能要件の網羅を確かめる", async () => {
    const { model, providerId } = await generateScreens([new MockProvider("m")], "予約", "", reqs);
    expect(providerId).toBe("m");
    expect(model.screens.map((s) => s.key)).toEqual(["S01", "S02"]);
    expect(model.screens[0]!.requirementCodes).toEqual(["FR-01", "FR-02"]);
    expect(model.screens[0]!.actions).toEqual([{ label: "次へ", to: "S02" }]);
    expect(model.screens[1]!.actions).toEqual([{ label: "戻る", to: "S01" }]);
    expect(model.dropped).toBe(2);
    expect(JSON.stringify(model)).not.toContain("color");
    expect(model.uncovered).toEqual([]);
  });

  it("意見をプロンプトに含めて作り直せる", async () => {
    const { model } = await generateScreens([new MockProvider("m")], "予約", "", reqs, { feedback: ["電話番号の入力欄が足りない"] });
    expect(model.screens[0]!.elements.map((e) => e.label)).toContain("意見を反映した項目");
  });

  it("ワイヤーフレームはスクリプトを含まず、文字を無害化し、イメージであることを示す", async () => {
    const { model } = await generateScreens([new MockProvider("m")], "<予約>", "", reqs);
    model.screens[0]!.elements.push({ kind: "text", label: '<script>alert("x")</script>' });
    const html = renderPrototypeHtml(model, "<予約>", reqs);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("色・文字の大きさ・配置・言葉づかいは、設計工程で決めます");
    expect(html).toContain('<label class="b go" for="go-S02">次へ →</label>');
    expect(html).toContain('id="go-S01" class="r" checked');
    expect(screenFlowMermaid(model)).toContain("S01 -->|次へ| S02");
  });

  it("画面への意見を、見た目の細部・要件・両方に振り分ける", () => {
    expect(classifyScreenFeedback("ボタンの色を青にして、もう少し大きくしてほしい").level).toBe("detail");
    expect(classifyScreenFeedback("ボタンを右側に置いてほしい").level).toBe("detail");
    expect(classifyScreenFeedback("電話番号の入力欄が足りない").level).toBe("requirement");
    expect(classifyScreenFeedback("予約を検索できるようにしたい").level).toBe("requirement");
    const mixed = classifyScreenFeedback("検索欄を追加して、文字を大きくしてほしい");
    expect(mixed.level).toBe("mixed");
    expect(mixed.detailHits).toEqual(["大きさ"]);
    expect(classifyScreenFeedback("3万円以上に絞り込みたい").level).toBe("requirement");
    expect(classifyScreenFeedback("色々な条件で探したい").detailHits).toEqual([]);
  });
});

describe("影響分析", () => {
  const ctx: ImpactContext = {
    projectName: "予約",
    requirements: reqs,
    stories: [
      { key: "E1-S1", title: "予約登録", requirementCodes: ["FR-01"], estimate: "M", links: [{ url: "https://github.com/a/b/issues/2", externalKey: "#2", integration: "GH" }] },
      { key: "E1-S2", title: "取消", requirementCodes: ["FR-02"], estimate: "S", links: [] },
    ],
    screens: [
      { key: "S01", name: "予約", requirementCodes: ["FR-01", "FR-02"] },
      { key: "S02", name: "空き枠", requirementCodes: ["FR-03"] },
    ],
    design: "クラス:\n- 予約（日時）",
    designElements: ["Reservation", "予約"],
  };
  const modify: ChangeProposal = {
    kind: "modify",
    code: "FR-01",
    before: { title: "予約を登録できる", description: "", priority: "must" },
    after: { title: "予約を登録・変更できる", description: "", priority: "must", type: "FR" },
    reason: "日時の変更が多い",
  };

  it("トレースで影響を見つけ、複数AIの指摘を票数つきでまとめ、選択肢を返す", async () => {
    const { report, usages } = await analyzeImpact([new MockProvider("a"), new MockProvider("b")], modify, ctx);
    expect(usages).toHaveLength(2);
    expect(report.analysts).toBe(2);
    expect(report.requirements[0]).toEqual({ item: { code: "FR-01", title: "予約を登録できる" }, votes: 2, traced: true });
    // 存在しない要件・要素は除く
    expect(report.requirements.map((r) => r.item.code)).not.toContain("FR-99");
    expect(report.design).toEqual([{ item: { name: "Reservation" }, votes: 2, traced: false }]);
    expect(report.stories).toEqual([{ item: { key: "E1-S1", title: "予約登録", points: 5 }, votes: 2, traced: true }]);
    expect(report.screens.map((s) => s.item.key)).toEqual(["S01"]);
    expect(report.issues).toEqual([{ storyKey: "E1-S1", url: "https://github.com/a/b/issues/2", externalKey: "#2", integration: "GH" }]);
    expect(report.effort).toBe("M");
    expect(report.risks).toHaveLength(2);
    expect(report.options.map((o) => o.key)).toEqual(["apply", "alternative", "defer", "reject"]);
    expect(report.alternatives).toHaveLength(1); // 2つのAIの同じ代替案はまとめる
    expect(report.options[0]!.consequence).toContain("ストーリー 1件（5ポイント分）");
    expect(report.options[0]!.consequence).toContain("登録済みの課題 1件");
  });

  it("AIがすべて失敗してもトレースの結果と選択肢を返す", async () => {
    const { report } = await analyzeImpact([new MockProvider("bad", () => "了解")], modify, ctx);
    expect(report.analysts).toBe(0);
    expect(report.failures[0]!.providerId).toBe("bad");
    expect(report.stories.map((s) => s.item.key)).toEqual(["E1-S1"]);
    expect(report.options.map((o) => o.key)).toEqual(["apply", "defer", "reject"]);
  });

  it("追加では、AIの過半数が関連すると判断した要件を起点にたどる", () => {
    const add: ChangeProposal = { kind: "add", code: null, before: null, after: { title: "空き枠を通知する", description: "", priority: "should", type: "FR" }, reason: "" };
    const base = { summary: "s", designElements: [], screens: [], stories: [], effort: "S" as const, risks: [], alternative: null };
    const r = buildImpactReport(add, ctx, [
      { providerId: "a", content: { ...base, relatedRequirementCodes: ["FR-03"] } },
      { providerId: "b", content: { ...base, relatedRequirementCodes: ["FR-03", "FR-02"] } },
      { providerId: "c", content: { ...base, relatedRequirementCodes: [] } },
    ]);
    // FR-03 は 2/3 → 起点になり、S02 がトレースで見つかる。FR-02 は 1/3 → 起点にしない
    expect(r.screens).toEqual([{ item: { key: "S02", name: "空き枠" }, votes: 0, traced: true }]);
    expect(r.stories).toEqual([]);
    expect(r.requirements.map((x) => [x.item.code, x.votes])).toEqual([
      ["FR-03", 2],
      ["FR-02", 1],
    ]);
    expect(r.scale).toBe("small");
    expect(r.options[0]!.label).toBe("要件を追加する");
  });
});
