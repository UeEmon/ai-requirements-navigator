import { describe, expect, it } from "vitest";
import {
  assessReadiness,
  batchTable,
  CandidateContent,
  DEFAULT_ACCEPTANCE,
  deriveTestCases,
  diffSnapshots,
  evaluateAcceptance,
  generateGlossary,
  generateScreens,
  generateUmlModel,
  glossaryFromDesign,
  lintRule,
  mergeGlossary,
  MockProvider,
  outputTable,
  PHASES,
  RequirementItem,
  screenItemTable,
  snapshotFingerprint,
  stateTable,
  summarizeUmlModel,
  termVariants,
  toMermaidState,
} from "../src/index.js";

describe("業務ルール（RL）", () => {
  it("ヒアリングに「業務ルール」の段階があり、具体例つきの要件になる", async () => {
    expect(PHASES.map((p) => p.key)).toEqual(["purpose", "actors", "flow", "functions", "rules", "quality", "constraints"]);
    const r = RequirementItem.parse({
      title: "前日までの取消は無料、当日は50%の取消料とする",
      type: "RL",
      rule: { kind: "calc", examples: [{ given: "2日前に取消", expected: "0円" }, { given: "当日に取消", expected: "料金の50%" }] },
      ears: { pattern: "event", response: "x" },
    });
    expect(r.rule!.kind).toBe("calc");
    expect(r.ears).toBeUndefined(); // EARS は FR・NFR だけ
    expect(RequirementItem.parse({ title: "x", type: "FR", rule: { kind: "calc" } }).rule).toBeUndefined();
    // 模擬AIも業務ルールの段階では具体例を返す
    const text = await new MockProvider("m").complete({ system: "あなたは要件定義の専門家です", messages: [{ role: "user", content: "主に作る要件の区分: RL\n# 利用者の回答\n取消料がある" }] });
    const c = CandidateContent.parse(JSON.parse(text.text));
    expect(c.items.every((i) => i.type === "RL" && (i.rule?.examples.length ?? 0) >= 2)).toBe(true);
  });

  it("具体例が2つ未満・あいまいな言葉を指摘し、具体例からテストケースを作る", () => {
    expect(lintRule("料金はなるべく安く計算する", { kind: "calc", examples: [{ given: "1人", expected: "1000円" }], entities: [] }).issues.map((i) => i.kind)).toEqual(["examples", "ambiguous"]);
    expect(lintRule("x", null).issues[0]!.message).toContain("ありません");
    const rule = { kind: "calc" as const, examples: [{ given: "大人2人・平日", expected: "4,000円" }, { given: "大人2人・休日", expected: "5,000円" }], entities: ["料金"] };
    expect(lintRule("料金は人数と曜日で決まる", rule).ok).toBe(true);
    const cases = deriveTestCases([{ code: "RL-01", type: "RL", title: "料金は人数と曜日で決まる", rule }, { code: "RL-02", type: "RL", title: "例のないルール", rule: null }]);
    expect(cases.map((c) => [c.id, c.kind, c.given, c.then])).toEqual([
      ["TC-RL-01-1", "example", "大人2人・平日", "4,000円"],
      ["TC-RL-01-2", "example", "大人2人・休日", "5,000円"],
      ["TC-RL-02-1", "normal", "通常の利用状態", "「例のないルール」のとおりに動作する"],
    ]);
  });
});

describe("設計モデルの補足（状態が変わる条件・保存期間・失敗時の扱い・帳票・バッチ）と画面の項目", () => {
  const model = async () => (await generateUmlModel([new MockProvider("d")], "予約", "", [{ code: "FR-01", type: "FR", title: "予約する" }])).model;

  it("状態遷移の条件を図と表に、帳票・バッチを一覧にする", async () => {
    const m = await model();
    expect(toMermaidState(m.stateMachines[0]!)).toContain(": 取消 ［利用日の前日まで］");
    expect(stateTable(m).rows).toContainEqual(["予約", "確定", "キャンセル", "取消", "利用日の前日まで"]);
    expect(outputTable(m).rows[0]).toEqual(["OUT-01", "日別予約表", "帳票", "当日の準備", "毎朝8時", "店長", "時刻、顧客名、メニュー、担当", "FR-01"]);
    expect(batchTable(m).rows[0]![0]).toBe("BAT-01");
    expect(summarizeUmlModel(m)).toContain("まとめて行う処理「前日リマインド」");
  });

  it("画面の入出力項目をデータ項目定義にひも付け、ひも付いていない入力を示す", async () => {
    const m = await model();
    const sc = (await generateScreens([new MockProvider("s")], "予約", "", [{ code: "FR-01", type: "FR", title: "予約する" }])).model;
    sc.screens[0]!.elements.push({ kind: "select", label: "メニュー" }, { kind: "field", label: "謎", field: "Nope.x" });
    const t = screenItemTable(sc, m);
    expect(t.rows).toContainEqual(["S01 トップ", "日時", "入力", "予約.日時", "Reservation.startAt", "必須", "現在より後、営業時間内", ""]);
    expect(t.rows).toContainEqual(["S01 トップ", "一覧", "表示", "予約.状態", "Reservation.status", "必須", "", "仮予約 / 確定 / キャンセル / 来店済み"]);
    expect(t.unbound).toEqual(["S01 トップ「メニュー」"]);
    expect(t.unknown).toEqual(["S01 トップ「謎」→ Nope.x"]);
  });
});

describe("用語集", () => {
  it("設計とAIから作り、人が書いた用語は上書きしない。要件文の表記ゆれを見つける", async () => {
    const m = (await generateUmlModel([new MockProvider("d")], "予約", "", [])).model;
    const fromDesign = glossaryFromDesign(m);
    expect(fromDesign.map((t) => [t.term, t.codeName])).toContainEqual(["予約", "Reservation"]);
    const ai = await generateGlossary([new MockProvider("g")], { projectName: "予約", reqs: [], design: summarizeUmlModel(m), current: fromDesign });
    expect(ai.terms.find((t) => t.term === "予約")).toMatchObject({ synonyms: ["申込"], codeName: "Reservation", source: "ai" });
    const manual = { term: "顧客", definition: "店に来る人", synonyms: [], codeName: "", source: "manual" as const };
    const merged = mergeGlossary([manual, ...fromDesign.filter((t) => t.term !== "顧客")], ai.terms);
    expect(merged.find((t) => t.term === "顧客")).toEqual(manual);
    expect(merged.find((t) => t.term === "予約")!.definition).toContain("模擬AI");
    expect(termVariants([{ code: "FR-01", title: "申込を受け付ける" }, { code: "FR-02", title: "予約を受け付ける" }], merged)).toEqual([{ code: "FR-01", used: "申込", term: "予約" }]);
  });
});

describe("受け入れ基準", () => {
  it("テスト結果と質問の状況に照らして判定する", () => {
    const rows = [
      { code: "FR-01", type: "FR", priority: "must", tests: { total: 2, status: "passed", failed: 0 } },
      { code: "FR-02", type: "FR", priority: "must", tests: { total: 2, status: "failed", failed: 1 } },
      { code: "FR-03", type: "FR", priority: "should", tests: { total: 1, status: "passed", failed: 0 } },
      { code: "NFR-01", type: "NFR", priority: "must", tests: { total: 1, status: "not_run", failed: 0 } },
    ];
    const r = evaluateAcceptance(DEFAULT_ACCEPTANCE, rows, 1);
    expect(Object.fromEntries(r.items.map((i) => [i.key, i.ok]))).toEqual({ must: false, should: true, failed: false, nfr: false, questions: false, "custom:C1": false, "custom:C2": false });
    expect(r.items[0]!.actual).toBe("33%（1/3）");
    expect(r.accepted).toBe(false);
    const ok = evaluateAcceptance({ ...DEFAULT_ACCEPTANCE, custom: [], nfrAllRun: false, questionsClosed: false, mustPassRate: 30, maxFailedTests: 1 }, rows, 1);
    expect(ok.accepted).toBe(true);
  });
});

describe("確定版の差分", () => {
  it("追加・変更（文・優先度・構造だけの変更）・削除を出す", () => {
    const v1 = [
      { code: "FR-01", type: "FR", title: "a", description: "", priority: "must", version: 1 },
      { code: "FR-02", type: "FR", title: "b", description: "", priority: "should", version: 1 },
      { code: "RL-01", type: "RL", title: "c", description: "", priority: "must", version: 1 },
      { code: "FR-03", type: "FR", title: "d", description: "", priority: "must", version: 1 },
    ];
    const v2 = [
      { ...v1[0]!, title: "a2", version: 2 },
      { ...v1[1]!, priority: "must", version: 2 },
      { ...v1[2]!, version: 3 }, // 具体例だけ変えた
      { code: "FR-04", type: "FR", title: "e", description: "", priority: "could", version: 1 },
    ];
    const d = diffSnapshots(v1, v2);
    expect(d.added.map((x) => x.code)).toEqual(["FR-04"]);
    expect(d.removed.map((x) => x.code)).toEqual(["FR-03"]);
    expect(d.modified.map((x) => [x.code, x.fields])).toEqual([
      ["FR-01", ["title"]],
      ["FR-02", ["priority"]],
      ["RL-01", ["detail"]],
    ]);
    expect(diffSnapshots(v1, v1)).toMatchObject({ added: [], removed: [], modified: [], unchanged: 4 });
    expect(snapshotFingerprint(v2)).toBe(snapshotFingerprint([...v2].reverse()));
    expect(snapshotFingerprint(v1) === snapshotFingerprint(v2)).toBe(false);
  });
});

describe("着手前チェックの追加項目", () => {
  it("業務ルール・用語集・受け入れ基準・承認・画面の項目・保存期間・失敗時の扱いを点検する", async () => {
    const uml = (await generateUmlModel([new MockProvider("d")], "予約", "", [])).model;
    const r = assessReadiness({
      requirements: [{ code: "FR-01", type: "FR", title: "x" }],
      nfr: { coverage: 1, errors: 0, undecided: [] },
      uml: { ...uml, classes: uml.classes.map((c) => ({ ...c, retention: "" })), interfaces: uml.interfaces.map((i) => ({ ...i, failure: "" })) },
      screens: { uncovered: [] },
      tasks: { uncovered: [], stories: 1 },
      tests: { untested: [], methodUndecided: [], methodGuessed: [], withoutAcceptance: [] },
      openQuestions: [],
      baselined: false,
      pendingChanges: [],
      accessControl: false,
      rules: { count: 0, issues: [] },
      glossary: { terms: 3, variants: ["FR-01（申込 → 予約）"] },
      acceptance: false,
      approval: { required: true, status: "stale" },
      screenItems: { unbound: ["S01 トップ「メニュー」"], unknown: [] },
      personalData: true,
    });
    const st = Object.fromEntries(r.checks.map((c) => [c.key, c.status]));
    expect(st).toMatchObject({ "req.rules": "warn", "req.glossary": "warn", "req.acceptance": "warn", "mgmt.approval": "ng", "design.screenItems": "warn", "design.retention": "warn", "design.failure": "warn" });
    expect(r.checks.find((c) => c.key === "mgmt.approval")!.detail).toContain("承認した後に要件が変わりました");
    expect(r.verdict).toBe("not-ready");
  });
});
