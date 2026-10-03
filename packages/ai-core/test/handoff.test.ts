import { describe, expect, it } from "vitest";
import {
  assessReadiness,
  boundariesOf,
  crudMatrix,
  dataDictionary,
  deriveTestCases,
  entityTable,
  expectationOf,
  generateUmlModel,
  interfaceTable,
  MockProvider,
  NFR_ITEMS,
  NFR_VERIFY,
  renderEars,
  testCasesCsv,
  toMermaidClass,
  traceTests,
  UmlModel,
  verificationOf,
  type Ears,
  type ReadinessInput,
} from "../src/index.js";

const ears = (e: Partial<Ears> & { response: string }): Ears => ({ pattern: "ubiquitous", trigger: "", state: "", feature: "", system: "予約システム", ...e });
const req = (code: string, type: string, e?: Ears, nfrKey?: string) => ({ code, type, title: e ? renderEars(e) : `${code}の要件`, ears: e ?? null, nfrKey });

describe("テスト仕様の導出（EARS → テストケース）", () => {
  it("応答を期待する結果の言い方に直す", () => {
    expect(expectationOf("確認メールを送信しなければならない")).toBe("確認メールを送信する");
    expect(expectationOf("利用を再開できるようにしなければならない")).toBe("利用を再開できるようにする");
    expect(expectationOf("稼働率99%以上を維持しなければならない")).toBe("稼働率99%以上を維持する");
    expect(expectationOf("説明なしで主要な操作を完了できなければならない")).toBe("説明なしで主要な操作を完了できる");
    expect(expectationOf("状態を保たなければならない")).toBe("状態を保つ");
    expect(expectationOf("色だけに頼らずに情報を伝えなければならない")).toBe("色だけに頼らずに情報を伝える");
    expect(expectationOf("過去の版を消さないようにしなければならない")).toBe("過去の版を消さないようにする");
  });

  it("型ごとに正常系・異常系・状態の内外・機能の有無を作る", () => {
    const reqs = [
      req("FR-01", "FR", ears({ pattern: "event", trigger: "顧客が予約を確定した", response: "確認メールを送信しなければならない" })),
      req("FR-02", "FR", ears({ pattern: "state", state: "受付期間中である", response: "予約を受け付けなければならない" })),
      req("FR-03", "FR", ears({ pattern: "unwanted", trigger: "決済に失敗した", response: "予約を仮予約のまま残さなければならない" })),
      req("FR-04", "FR", ears({ pattern: "optional", feature: "多言語表示の機能", response: "英語で表示しなければならない" })),
      req("FR-05", "FR", ears({ pattern: "complex", state: "メンテナンス中である", trigger: "利用者がログインした", response: "お知らせを表示しなければならない" })),
      req("FR-06", "FR", ears({ response: "予約の一覧を表示しなければならない" })),
      req("FR-07", "FR"), // EARS の構造なし
      req("BR-01", "BR"), // 対象外
    ];
    const cases = deriveTestCases(reqs);
    const kinds = (code: string) => cases.filter((c) => c.requirementCode === code).map((c) => c.kind);
    expect(kinds("FR-01")).toEqual(["normal", "negative"]);
    expect(kinds("FR-02")).toEqual(["state-in", "state-out"]);
    expect(kinds("FR-03")).toEqual(["abnormal"]);
    expect(kinds("FR-04")).toEqual(["option-on", "option-off"]);
    expect(kinds("FR-05")).toEqual(["state-in", "state-out"]);
    expect(kinds("FR-06")).toEqual(["normal"]);
    expect(kinds("FR-07")).toEqual(["normal"]);
    expect(kinds("BR-01")).toEqual([]);
    const fr1 = cases.find((c) => c.id === "TC-FR-01-1")!;
    expect(fr1).toMatchObject({ when: "顧客が予約を確定した", then: "予約システムが確認メールを送信する", level: "system", source: "rule" });
    expect(cases.find((c) => c.id === "TC-FR-03-1")!.when).toBe("決済に失敗した");
    expect(cases.find((c) => c.id === "TC-FR-07-1")!.then).toContain("FR-07の要件");
    // 同じ要件からは同じIDとケースが出る
    expect(deriveTestCases(reqs)).toEqual(cases);
  });

  it("数値と単位を含む要件には境界値のケースを足す", () => {
    expect(boundariesOf("3秒以内に表示し、100件まで、3秒")).toEqual([
      { value: "3", unit: "秒" },
      { value: "100", unit: "件" },
    ]);
    const cases = deriveTestCases([req("FR-01", "FR", ears({ pattern: "event", trigger: "検索した", response: "3秒以内に結果を表示しなければならない" }))]);
    expect(cases.map((c) => c.kind)).toEqual(["normal", "negative", "boundary"]);
    expect(cases[2]!.title).toBe("境界値 3秒");
  });

  it("非機能要件は確認方法つきのケースにする（シートの項目 → 文の言葉 → 未定）", () => {
    // 非機能要件シートの全項目に確認方法がある
    expect(NFR_ITEMS.filter((i) => !NFR_VERIFY[i.key]).map((i) => i.key)).toEqual([]);
    const reqs = [
      req("NFR-01", "NFR", ears({ pattern: "unwanted", trigger: "障害でシステムが停止した", response: "1時間以内に利用を再開できるようにしなければならない" }), "av.rto"),
      req("NFR-02", "NFR", ears({ response: "通信を暗号化しなければならない" })),
      req("NFR-03", "NFR", ears({ response: "画面の配色を会社の規定に合わせなければならない" })),
    ];
    const cases = deriveTestCases(reqs);
    const nfr1 = cases.find((c) => c.id === "TC-NFR-01-1")!;
    expect(nfr1).toMatchObject({ kind: "nfr", level: "nfr", title: "復旧訓練", when: "障害でシステムが停止した" });
    expect(nfr1.method).toContain("復旧訓練");
    expect(cases.find((c) => c.id === "TC-NFR-01-2")!.kind).toBe("boundary"); // 1時間
    expect(cases.find((c) => c.id === "TC-NFR-02-1")!.method).toContain("推定");
    expect(cases.find((c) => c.id === "TC-NFR-03-1")!.title).toBe("確認方法を決める");
    expect(verificationOf({ title: "x", nfrKey: "sc.vuln" })).toMatchObject({ method: "脆弱性診断", guessed: false });

    const t = traceTests(reqs, cases);
    expect(t.methodUndecided).toEqual(["NFR-03"]);
    expect(t.rows.find((r) => r.code === "NFR-02")).toMatchObject({ method: "暗号化の確認", methodGuessed: true });
  });

  it("ストーリーの受け入れ条件を受け入れテストにし、要件から辿れる", () => {
    const reqs = [req("FR-01", "FR", ears({ response: "予約を表示しなければならない" })), req("FR-02", "FR", ears({ response: "予約を取り消せなければならない" }))];
    const stories = [{ key: "S-1", title: "予約を見る・取り消す", acceptanceCriteria: ["一覧に自分の予約だけが出る", "取消後は一覧から消える"], requirementCodes: ["FR-01", "FR-02"] }];
    const cases = deriveTestCases(reqs, stories);
    const at = cases.filter((c) => c.level === "acceptance");
    expect(at.map((c) => c.id)).toEqual(["AT-S-1-1", "AT-S-1-2"]);
    expect(at[0]).toMatchObject({ then: "一覧に自分の予約だけが出る", storyKey: "S-1", source: "story" });
    const t = traceTests(reqs, cases, stories);
    expect(t.rows.find((r) => r.code === "FR-02")!.acceptance).toEqual(["AT-S-1-1", "AT-S-1-2"]);
    expect(t.coverage).toBe(1);
    expect(t.untested).toEqual([]);

    const csv = testCasesCsv(cases);
    expect(csv.startsWith("﻿テストID,要件ID,種別")).toBe(true);
    expect(csv).toContain("AT-S-1-1,FR-01,受け入れ,受け入れテスト");
  });
});

describe("設計モデルの表（データ項目定義・権限表・外部とのやり取り）", () => {
  const model = async () => (await generateUmlModel([new MockProvider("d")], "予約", "", [{ code: "FR-01", type: "FR", title: "予約する" }])).model;

  it("データ項目定義にキー・必須・桁や形式・区分値が載る", async () => {
    const t = dataDictionary(await model());
    expect(t.head).toEqual(["エンティティ", "項目", "コード上の名前", "型", "キー", "必須", "桁・形式・範囲", "区分値"]);
    expect(t.rows).toContainEqual(["予約（Reservation）", "状態", "status", "enum", "", "必須", "", "仮予約 / 確定 / キャンセル / 来店済み"]);
    expect(t.rows).toContainEqual(["顧客（Customer）", "顧客ID", "id", "string", "主キー", "必須", "", ""]);
    expect(entityTable(await model()).rows[1]).toEqual(["予約", "Reservation", "4", "", "FR-01, FR-02"]);
    expect(entityTable(await model()).rows[0]![3]).toBe("最後の来店から5年で削除");
  });

  it("権限表は役割 × エンティティの CRUD。存在しないエンティティへの権限は捨てる", async () => {
    const t = crudMatrix(await model());
    expect(t.head).toEqual(["役割", "顧客", "予約", "スタッフ", "メニュー"]);
    expect(t.rows).toEqual([
      ["顧客", "CRU", "CRU", "－", "R"],
      ["店長", "R", "CRUD", "CRUD", "CRUD"],
    ]);
    const m = UmlModel.parse({ classes: [{ name: "A" }], permissions: [{ actor: "x", entity: "A", ops: "rud" }, { actor: "x", entity: "Nope", ops: "R" }] });
    expect(m.permissions[0]!.ops).toBe("RUD");
    const { normalizeUmlModel } = await import("../src/index.js");
    expect(normalizeUmlModel(m).model.permissions).toHaveLength(1);
  });

  it("外部とのやり取りに番号を振る。クラス図にはキーの印が付く", async () => {
    const m = await model();
    expect(interfaceTable(m).rows[0]).toEqual(["IF-01", "予約確認メール", "メール配信サービス", "送る", "API", "予約確定のつど", "顧客のメールアドレス、予約日時、メニュー", "予約は確定し、メールは再送の対象にして店長に知らせる", "FR-02"]);
    expect(toMermaidClass(m)).toContain("Reservation : +予約ID string PK");
  });

  it("古い設計モデル（項目に名前と型しかない）でも表を作れる", () => {
    const old = { classes: [{ name: "Customer", label: "顧客", attributes: [{ name: "氏名", type: "string" }], operations: [] }], relations: [], sequences: [], stateMachines: [], activities: [] } as unknown as UmlModel;
    expect(dataDictionary(old).rows).toEqual([["顧客（Customer）", "氏名", "", "string", "", "", "", ""]]);
    expect(crudMatrix(old).rows).toEqual([]);
    expect(interfaceTable(null).rows).toEqual([]);
  });
});

describe("着手前チェック", () => {
  const base = (): ReadinessInput => ({
    requirements: [
      { code: "AC-01", type: "AC", title: "顧客" },
      { code: "AC-02", type: "AC", title: "店長" },
      { code: "FR-01", type: "FR", title: renderEars(ears({ pattern: "event", trigger: "予約を確定した", response: "確認メールを送信しなければならない" })), ears: ears({ pattern: "event", trigger: "予約を確定した", response: "確認メールを送信しなければならない" }) },
    ],
    nfr: { coverage: 1, errors: 0, undecided: [] },
    uml: null,
    screens: { uncovered: [] },
    tasks: { uncovered: [], stories: 3 },
    tests: { untested: [], methodUndecided: [], methodGuessed: [], withoutAcceptance: [] },
    openQuestions: [],
    baselined: true,
    pendingChanges: [],
    accessControl: true,
  });

  it("設計モデルがなければ引き渡せない", () => {
    const r = assessReadiness(base());
    expect(r.verdict).toBe("not-ready");
    expect(r.checks.find((c) => c.key === "design.model")!.status).toBe("ng");
  });

  it("すべてそろえば引き渡せる", async () => {
    const uml = (await generateUmlModel([new MockProvider("d")], "予約", "", [])).model;
    const r = assessReadiness({ ...base(), uml });
    expect(r.checks.filter((c) => c.status !== "ok").map((c) => c.key)).toEqual([]);
    expect(r).toMatchObject({ verdict: "ready", score: 100 });
  });

  it("足りないものを、どこで直すかと一緒に示す", async () => {
    const uml = (await generateUmlModel([new MockProvider("d")], "予約", "", [])).model;
    const r = assessReadiness({
      ...base(),
      uml: { ...uml, permissions: [], interfaces: [] },
      requirements: [...base().requirements, { code: "FR-02", type: "FR", title: "適切に表示する" }],
      nfr: { coverage: 0.8, errors: 0, undecided: ["バックアップ"] },
      openQuestions: ["キャンセル料は取るか"],
      tests: { untested: [], methodUndecided: ["NFR-03"], methodGuessed: [], withoutAcceptance: ["FR-02"] },
      baselined: false,
      pendingChanges: ["CR-01"],
    });
    const st = Object.fromEntries(r.checks.map((c) => [c.key, c.status]));
    expect(st).toMatchObject({
      "req.ears": "warn",
      "req.questions": "warn",
      "req.nfr": "warn",
      "design.permissions": "warn",
      "design.interfaces": "warn", // 「確認メールを送信」→ 外部とのやり取りがありそう
      "test.acceptance": "warn",
      "test.nfr": "warn",
      "mgmt.baseline": "warn",
      "mgmt.changes": "warn",
    });
    expect(r.checks.find((c) => c.key === "req.ears")!).toMatchObject({ items: ["FR-02"], where: "要件一覧" });
    expect(r.verdict).toBe("conditional");
    expect(r.score).toBeLessThan(100);
  });
});
