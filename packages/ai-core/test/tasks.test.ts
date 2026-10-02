import { describe, expect, it } from "vitest";
import {
  generateTaskPlan,
  MockProvider,
  normalizeTaskPlan,
  storyBody,
  TaskPlanContent,
  toBacklogCsv,
  toJiraCsv,
  toTaskMarkdown,
  traceRequirements,
  type TaskRequirement,
} from "../src/index.js";

const reqs: TaskRequirement[] = [
  { code: "BR-01", type: "BR", title: "電話予約を減らす" },
  { code: "FR-01", type: "FR", title: "予約を登録できる", priority: "must" },
  { code: "FR-02", type: "FR", title: "予約を取り消せる" },
  { code: "NFR-01", type: "NFR", title: "3秒以内に表示する" },
];

describe("タスク分解", () => {
  it("模擬AIで要件をエピック・ストーリー・タスクに分解し、すべての要件に対応する", async () => {
    const r = await generateTaskPlan([new MockProvider("t")], "予約", "電話を減らす", reqs);
    expect(r.providerId).toBe("t");
    expect(r.plan.epics.map((e) => e.key)).toEqual(["E1", "E2"]);
    expect(r.plan.epics[0]!.stories.map((s) => s.key)).toEqual(["E1-S1", "E1-S2"]);
    expect(r.plan.epics[0]!.requirementCodes).toEqual(["FR-01", "FR-02"]);
    expect(r.plan.uncovered).toEqual([]);
    expect(r.plan.epics[0]!.stories[0]!.tasks.some((t) => t.kind === "test")).toBe(true);
  });

  it("存在しない要件コードを取り除き、未対応の機能・非機能要件を検出する（業務要件は対象外）", () => {
    const content = TaskPlanContent.parse({
      epics: [
        {
          title: "予約",
          stories: [
            { title: "登録", requirementCodes: ["FR-01", "FR-01", "FR-99"], estimate: "xl", tasks: [{ title: "API", kind: "謎" }] },
          ],
        },
      ],
    });
    const plan = normalizeTaskPlan(content, reqs);
    const s = plan.epics[0]!.stories[0]!;
    expect(s.requirementCodes).toEqual(["FR-01"]);
    expect(s.estimate).toBe("M");
    expect(s.tasks[0]!.kind).toBe("other");
    expect(plan.unknownCodes).toEqual(["FR-99"]);
    expect(plan.uncovered).toEqual(["FR-02", "NFR-01"]);
  });

  it("壊れた出力のAIは飛ばし、すべて失敗したら理由を返す", async () => {
    const bad = new MockProvider("bad", () => '{"epics": []}');
    const r = await generateTaskPlan([bad, new MockProvider("ok")], "予約", "", reqs);
    expect(r.providerId).toBe("ok");
    expect(r.failures[0]!.providerId).toBe("bad");
    await expect(generateTaskPlan([bad], "予約", "", reqs)).rejects.toMatchObject({ failures: [{ providerId: "bad" }] });
  });

  it("Markdown・CSV・登録用本文を出力する", async () => {
    const { plan } = await generateTaskPlan([new MockProvider("t")], "予約", "", reqs);
    const md = toTaskMarkdown(plan, "予約", reqs);
    expect(md).toContain("## E1 基本機能");
    expect(md).toContain("| FR-01 予約を登録できる | E1-S1 |");

    const body = storyBody(plan.epics[0]!.stories[0]!, plan.epics[0]!, reqs);
    expect(body).toContain("- [ ] [テスト] テストを書く");
    expect(body).toContain("- FR-01 予約を登録できる");
    expect(storyBody(plan.epics[0]!.stories[0]!, plan.epics[0]!, reqs, "jira")).toContain("h3. 受け入れ条件");

    const jira = toJiraCsv(plan, reqs).split("\r\n");
    expect(jira[0]).toBe('"Issue Id","Parent Id","Issue Type","Summary","Description","Story Points","Labels"');
    expect(jira[1]).toMatch(/^"1","","Epic","基本機能"/);
    expect(jira[2]).toMatch(/^"2","1","Story","予約を登録できる"/);
    expect(jira[3]).toMatch(/^"3","2","Sub-task"/);

    const backlog = toBacklogCsv(plan, reqs);
    expect(backlog.split("\r\n")[0]).toBe('"件名","詳細","種別","カテゴリー名","優先度","予定時間"');
    expect(backlog).toContain('"E1-S1 予約を登録できる"');
  });

  it("CSVで式として解釈される値を無害化する", () => {
    const content = TaskPlanContent.parse({ epics: [{ title: "=HYPERLINK(\"x\")", stories: [{ title: "+cmd", description: '"引用"' }] }] });
    const csv = toJiraCsv(normalizeTaskPlan(content, reqs), reqs);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"'+cmd"`);
  });

  it("要件ごとの対応ストーリーを返す", async () => {
    const { plan } = await generateTaskPlan([new MockProvider("t")], "予約", "", reqs);
    const t = traceRequirements(plan, reqs);
    expect(t.find((x) => x.code === "NFR-01")!.stories.map((s) => s.key)).toEqual(["E2-S1"]);
    expect(t.find((x) => x.code === "BR-01")).toMatchObject({ target: false, stories: [] });
  });
});
