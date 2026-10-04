import { describe, expect, it } from "vitest";
import {
  activityFromRequirements,
  buildDiagrams,
  compareUmlModels,
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

describe("UMLの複数AI比較", () => {
  it("複数AIの設計モデルを匿名化して評価し、合計点をアプリ側で計算する", async () => {
    const events: string[] = [];
    const r = await compareUmlModels([new MockProvider("c"), new MockProvider("o")], new MockProvider("judge"), "予約", "", reqs, {
      random: () => 0.1,
      onProgress: (e) => events.push(`${e.type}:${e.providerId}:${e.status}`),
    });
    expect(r.candidates.map((c) => c.label)).toEqual(["A", "B"]);
    expect(new Set(r.candidates.map((c) => c.providerId))).toEqual(new Set(["c", "o"]));
    expect(r.evaluation!.totals.A).toBe(Math.round((80 + 78 + 75 + 82) / 4));
    expect(r.evaluation!.recommendedLabel).toBe("A");
    expect(events).toEqual(expect.arrayContaining(["generator:c:running", "generator:c:done", "evaluator:judge:done"]));
  });

  it("評価AIには作成者を伝えない", async () => {
    let seen = "";
    const judge = new MockProvider("judge", async (req) => {
      seen = req.messages[0]!.content;
      return (await new MockProvider("judge").complete(req)).text;
    });
    await compareUmlModels([new MockProvider("claude-x"), new MockProvider("gpt-y")], judge, "予約", "", reqs);
    expect(seen).toContain("### 案A");
    expect(seen).not.toMatch(/claude-x|gpt-y/);
    expect(seen).toContain("予約 Reservation（id 予約ID、customerId 顧客、startAt 日時、status 状態）");
  });

  it("1案しかないときも、評価AIがあれば審査する（単独AI＋評価AI）。評価AIがなければ評価しない。全滅ならエラー", async () => {
    let seen = "";
    const judge = new MockProvider("judge", async (req) => {
      seen = req.messages[0]!.content;
      return (await new MockProvider("judge").complete(req)).text;
    });
    const r = await compareUmlModels([new MockProvider("c"), new MockProvider("bad", () => "x")], judge, "予約", "", reqs);
    expect(r.candidates).toHaveLength(1);
    expect(r.evaluation?.evaluatorId).toBe("judge");
    expect(seen).toContain("案は1つだけです");
    expect((await compareUmlModels([new MockProvider("c")], undefined, "予約", "", reqs)).evaluation).toBeNull();
    expect(r.failures.map((f) => f.providerId)).toEqual(["bad"]);
    await expect(compareUmlModels([new MockProvider("bad", () => "x")], undefined, "予約", "", reqs)).rejects.toThrow();
  });
});
