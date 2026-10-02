import { describe, expect, it } from "vitest";
import {
  activityFromRequirements,
  buildDiagrams,
  generateUmlModel,
  MockProvider,
  normalizeUmlModel,
  toMermaidActivity,
  toMermaidClass,
  toMermaidSequence,
  toMermaidState,
  toPlantUmlActivity,
  toPlantUmlClass,
  toPlantUmlSequence,
  toPlantUmlState,
  UmlModel,
} from "../src/index.js";

const reqs = [
  { code: "AC-01", type: "AC", title: "顧客：スマホから予約する" },
  { code: "FR-01", type: "FR", title: "顧客はメニューと日時を選んで予約する" },
  { code: "FR-02", type: "FR", title: "予約確定時に確認メールを送る" },
];

async function mockModel() {
  return (await generateUmlModel([new MockProvider("designer")], "予約", "", reqs)).model;
}

describe("UMLモデルの生成", () => {
  it("模擬AIのモデルを検証し、存在しない参照を取り除く", async () => {
    const r = await generateUmlModel([new MockProvider("designer")], "予約", "", reqs);
    expect(r.providerId).toBe("designer");
    expect(r.dropped).toBe(1); // Reservation → Unknown の関連
    expect(r.model.relations.every((x) => x.to !== "Unknown")).toBe(true);
  });

  it("最初のAIが失敗したら次のAIを使う", async () => {
    const bad = new MockProvider("bad", () => "設計しました");
    const r = await generateUmlModel([bad, new MockProvider("good")], "予約", "", reqs);
    expect(r.providerId).toBe("good");
    expect(r.failures.map((f) => f.providerId)).toEqual(["bad"]);
  });

  it("空のモデルは失敗として次のAIを試す", async () => {
    const empty = new MockProvider("empty", () => "{}");
    const r = await generateUmlModel([empty, new MockProvider("good")], "予約", "", reqs);
    expect(r.failures).toEqual([{ providerId: "empty", reason: "設計モデルが空です" }]);
  });

  it("すべて失敗したらエラー", async () => {
    await expect(generateUmlModel([new MockProvider("bad", () => "{}x")], "予約", "", reqs)).rejects.toThrow(
      "UMLモデルを生成できませんでした",
    );
  });

  it("状態遷移の初期状態が不正なら最初の状態にする", () => {
    const { model } = normalizeUmlModel(
      UmlModel.parse({
        stateMachines: [{ entity: "x", states: ["a", "b"], initial: "z", transitions: [{ from: "a", to: "q", event: "e" }] }],
      }),
    );
    expect(model.stateMachines[0]!.initial).toBe("a");
    expect(model.stateMachines[0]!.transitions).toEqual([]);
  });
});

describe("Mermaid / PlantUML への変換", () => {
  it("クラス図: 日本語ラベル、多重度、集約", async () => {
    const m = await mockModel();
    const mm = toMermaidClass(m);
    expect(mm).toContain('class Reservation["予約"]');
    expect(mm).toContain('Customer "1" --> "*" Reservation : 予約する');
    expect(mm).toContain('Reservation "*" o-- "1..*" Menu');
    expect(mm).toContain("Reservation : +キャンセルする()");
    const pu = toPlantUmlClass(m);
    expect(pu).toContain('class "予約" as Reservation {');
    expect(pu.startsWith("@startuml")).toBe(true);
  });

  it("クラス名が識別子でなければ代替名を使う", () => {
    const m = UmlModel.parse({ classes: [{ name: "予約" }, { name: "顧客" }], relations: [{ from: "顧客", to: "予約" }] });
    const mm = toMermaidClass(m);
    expect(mm).toContain('class C0["予約"]');
    expect(mm).toContain("C1 --> C0");
  });

  it("継承は親子の向きで描く", () => {
    const m = UmlModel.parse({ classes: [{ name: "Member" }, { name: "Person" }], relations: [{ from: "Member", to: "Person", kind: "inheritance" }] });
    expect(toMermaidClass(m)).toContain("Person <|-- Member");
    expect(toPlantUmlClass(m)).toContain("Member --|> Person");
  });

  it("シーケンス図: アクターと応答", async () => {
    const s = (await mockModel()).sequences[0]!;
    const mm = toMermaidSequence(s);
    expect(mm).toContain("actor customer as 顧客");
    expect(mm).toContain("server-->>web: 予約完了");
    expect(toPlantUmlSequence(s)).toContain('actor "顧客" as customer');
  });

  it("状態遷移図: 初期・終了状態", async () => {
    const sm = (await mockModel()).stateMachines[0]!;
    const mm = toMermaidState(sm);
    expect(mm).toContain('state "仮予約" as S0');
    expect(mm).toContain("[*] --> S0");
    expect(mm).toContain("S1 --> S2 : 取消");
    expect(mm).toContain("S3 --> [*]");
    expect(toPlantUmlState(sm)).toContain("@enduml");
  });

  it("アクティビティ図: 分岐とループ", async () => {
    const a = (await mockModel()).activities[0]!;
    const mm = toMermaidActivity(a);
    expect(mm).toContain('s2{"空き枠がある"}');
    expect(mm).toContain("s2 -->|はい| s3");
    expect(mm).toContain("START --> s1");
    expect(mm).toContain("s5 --> END");
    const pu = toPlantUmlActivity(a);
    expect(pu).toContain('"空き枠がある？" --> [いいえ] "別の日時を提案する"');
  });

  it("ラベルの構文記号を取り除く", () => {
    const m = UmlModel.parse({ classes: [{ name: "A", label: 'x"];[evil' }] });
    expect(toMermaidClass(m)).toContain('class A["xevil"]');
  });

  it("buildDiagrams: モデルなしでもユースケース図と簡易アクティビティ図を作る", async () => {
    const rule = buildDiagrams("予約", reqs);
    expect(rule.map((d) => d.kind)).toEqual(["usecase", "activity"]);
    expect(rule.every((d) => d.source === "rule")).toBe(true);
    const full = buildDiagrams("予約", reqs, await mockModel());
    expect(full.map((d) => d.kind)).toEqual(["usecase", "class", "sequence", "state", "activity"]);
    expect(activityFromRequirements([])).toBeNull();
  });
});
