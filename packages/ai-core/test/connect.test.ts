import { describe, expect, it } from "vitest";
import {
  deriveTestCases,
  JUnitParseError,
  matchResults,
  parseJUnitXml,
  renderAgentsMd,
  renderEars,
  requirementStatus,
  toGherkinFeatures,
  type Ears,
} from "../src/index.js";

const ears = (e: Partial<Ears> & { response: string }): Ears => ({ pattern: "ubiquitous", trigger: "", state: "", feature: "", system: "予約システム", ...e });
const e1 = ears({ pattern: "event", trigger: "顧客が予約を確定した", response: "確認メールを送信しなければならない" });
const e2 = ears({ pattern: "unwanted", trigger: "決済に失敗した", response: "予約を仮予約のまま残さなければならない" });
const reqs = [
  { code: "FR-01", type: "FR", title: renderEars(e1), ears: e1, version: 2 },
  { code: "FR-02", type: "FR", title: renderEars(e2), ears: e2, version: 1 },
  { code: "FR-03", type: "FR", title: "一覧を表示する", ears: null, version: 1 },
];
const stories = [{ key: "E1-S1", title: "予約する", acceptanceCriteria: ["確認メールが届く"], requirementCodes: ["FR-01"] }];
const cases = deriveTestCases(reqs, stories);

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<!-- vitest -->
<testsuites name="vitest" tests="5" failures="1">
  <testsuite name="reserve.test.ts" tests="5">
    <testcase classname="reserve.test.ts" name="TC-FR-01-1 予約を確定すると確認メールを送る" time="0.012"/>
    <testcase classname="reserve.test.ts" name="TC-FR-01-2 確定していなければ送らない" time="0.003">
      <failure message="expected 0 to be 1 &amp; more" type="AssertionError"><![CDATA[at reserve.test.ts:12 <x>]]></failure>
    </testcase>
    <testcase classname="reserve.test.ts" name="FR-03 一覧" time="0.1"></testcase>
    <testcase classname="AT-E1-S1-1" name="受け入れ"><skipped/></testcase>
    <testcase classname="misc" name="ユーティリティの関数"/>
  </testsuite>
</testsuites>`;

describe("テスト結果の取り込み（JUnit XML）", () => {
  it("testcase ごとに合否・メッセージ・時間を読む", () => {
    const r = parseJUnitXml(JUNIT);
    expect(r).toHaveLength(5);
    expect(r[0]).toMatchObject({ name: "TC-FR-01-1 予約を確定すると確認メールを送る", status: "passed", durationMs: 12 });
    expect(r[1]).toMatchObject({ status: "failed", message: "expected 0 to be 1 & more" });
    expect(r[3]).toMatchObject({ classname: "AT-E1-S1-1", status: "skipped" });
    // 属性に message がなければ本文（CDATA）を使う
    expect(parseJUnitXml('<testsuite><testcase name="x"><error>boom &lt;1&gt;</error></testcase></testsuite>')[0]).toMatchObject({ status: "failed", message: "boom <1>" });
  });

  it("外部実体を含む XML と、JUnit でないものは受け付けない", () => {
    expect(() => parseJUnitXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite/>')).toThrow();
    expect(() => parseJUnitXml("<html></html>")).toThrow();
    expect(parseJUnitXml("<testsuites></testsuites>")).toEqual([]);
    try {
      parseJUnitXml("<a/>");
    } catch (e) {
      expect(e instanceof JUnitParseError).toBe(true);
    }
  });

  it("名前のテストID・要件IDで結びつける（知らないIDは使わない）", () => {
    const m = matchResults(
      [...parseJUnitXml(JUNIT), { testId: "TC-FR-01-1", status: "failed", message: "2回目は失敗" }, { name: "TC-FR-99-1 存在しない", status: "passed" }],
      cases.map((c) => c.id),
      reqs.map((r) => r.code),
    );
    expect(m.tests.map((t) => [t.testId, t.status])).toEqual([
      ["TC-FR-01-1", "failed"], // 同じテストが2回あれば不合格を優先
      ["TC-FR-01-2", "failed"],
      ["AT-E1-S1-1", "skipped"],
    ]);
    expect(m.tests[0]!.message).toBe("2回目は失敗");
    expect(m.requirements).toEqual([{ requirementCode: "FR-03", status: "passed", name: "FR-03 一覧", message: undefined }]);
    expect(m.unmatched).toEqual(["ユーティリティの関数", "TC-FR-99-1 存在しない"]);
  });
});

describe("要件ごとの実装状況とテスト結果", () => {
  it("最新の報告・最新のテスト結果で集計し、報告後に要件が変わったものを示す", () => {
    const run1 = { id: "r1", at: "2026-10-01T00:00:00Z", ...matchResults(parseJUnitXml(JUNIT), cases.map((c) => c.id), ["FR-03"]) };
    const run2 = { id: "r2", at: "2026-10-02T00:00:00Z", ...matchResults([{ name: "TC-FR-01-2 直した", status: "passed" as const }], cases.map((c) => c.id), []) };
    const impl = [
      { requirementCode: "FR-01", status: "in_progress" as const, requirementVersion: 1, refs: [], note: "", reportedBy: "agent", at: "2026-10-01T00:00:00Z" },
      { requirementCode: "FR-01", status: "implemented" as const, requirementVersion: 1, refs: [{ label: "PR #12", url: "https://example.com/pr/12" }], note: "", reportedBy: "agent", at: "2026-10-02T00:00:00Z" },
      { requirementCode: "FR-02", status: "blocked" as const, requirementVersion: 1, refs: [], note: "決済の仕様待ち", reportedBy: "agent", at: "2026-10-02T00:00:00Z" },
    ];
    const s = requirementStatus(reqs, cases, impl, [run2, run1]);
    const fr1 = s.rows.find((r) => r.code === "FR-01")!;
    expect(fr1.impl).toMatchObject({ status: "implemented", stale: true }); // 報告は第1版、いまは第2版
    // TC-FR-01-2 は1回目に不合格、2回目（新しい）で合格。受け入れテスト AT-E1-S1-1 はスキップ
    expect(fr1.tests).toMatchObject({ total: 3, passed: 2, failed: 0, skipped: 1, notRun: 0, status: "partial", lastRunAt: "2026-10-02T00:00:00Z" });
    // 古い順に渡すと、1回目の不合格が最新になる
    expect(requirementStatus(reqs, cases, impl, [run1, run2]).rows[0]!.tests).toMatchObject({ failed: 1, status: "failed", failures: [{ testId: "TC-FR-01-2", message: "expected 0 to be 1 & more" }] });
    expect(s.rows.find((r) => r.code === "FR-02")!.tests.status).toBe("not_run");
    expect(s.rows.find((r) => r.code === "FR-03")!.tests).toMatchObject({ total: 1, passed: 1, status: "passed" });
    expect(s.summary).toMatchObject({ implemented: 1, blocked: 1, unreported: 1, stale: 1, tested: 2, testPassed: 1, testFailed: 0 });
    // 受け入れテスト（AT）はストーリーの最初の要件に数える
    expect(cases.find((c) => c.id === "AT-E1-S1-1")!.requirementCode).toBe("FR-01");
  });
});

describe("リポジトリ用の出力", () => {
  it("Gherkin（日本語のキーワード）にテストIDのタグを付ける", () => {
    const f = toGherkinFeatures(reqs, cases, stories);
    expect(f.map((x) => x.path)).toEqual(["tests/acceptance/FR-01.feature", "tests/acceptance/FR-02.feature", "tests/acceptance/FR-03.feature", "tests/acceptance/stories/E1-S1.feature"]);
    const fr1 = f[0]!.content;
    expect(fr1.startsWith("# language: ja\n")).toBe(true);
    expect(fr1).toContain("@FR-01\n機能: FR-01 顧客が予約を確定したとき");
    expect(fr1).toContain("  @TC-FR-01-1 @正常系\n  シナリオ: TC-FR-01-1");
    expect(fr1).toContain("    もし 顧客が予約を確定した\n    ならば 予約システムが確認メールを送信する");
    expect(fr1).not.toContain("AT-E1-S1-1");
    expect(f[3]!.content).toContain("@E1-S1 @FR-01\n機能: E1-S1 予約する");
    expect(f[3]!.content).toContain("ならば 確認メールが届く");
  });

  it("AGENTS.md に作業の決まりと接続先を書く", () => {
    const md = renderAgentsMd({
      projectName: "予約",
      purpose: "電話予約を減らす",
      projectId: "p1",
      serverUrl: "https://arn.example.com",
      baseline: { version: 2, createdAt: "2026-10-03T01:00:00Z" },
      counts: { FR: 3, NFR: 1 },
      verdict: "確認事項を共有すれば着手できる",
      openQuestions: ["キャンセル料は取るか"],
      nfr: ["画面の応答時間：3秒以内"],
      files: ["AGENTS.md"],
    });
    expect(md).toContain("確定版 第2版（2026-10-03）");
    expect(md).toContain("機能要件 3件・業務ルール 0件・非機能要件 1件");
    expect(md).toContain("`https://arn.example.com/mcp`");
    expect(md).toContain("TC-FR-03-1");
    expect(md).toContain("  - キャンセル料は取るか");
    expect(md).toContain("- 画面の応答時間：3秒以内");
  });
});
