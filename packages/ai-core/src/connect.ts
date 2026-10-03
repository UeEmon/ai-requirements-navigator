/**
 * AIコーディングツール・テストツールとの連携（機能 F10）。
 *
 * - テスト結果の取り込み: JUnit XML（ほぼすべてのテストツールが出力できる形式）と JSON を受け、
 *   テスト名に含まれるテストID（TC-FR-01-1 / AT-E1-S1-1）や要件ID（FR-01）で要件に結びつける
 * - 状況の集計: 要件ごとの実装状況（報告）とテスト結果（合格・不合格・未実施）
 * - リポジトリ用の出力: Gherkin（.feature）のテストシナリオ、AIコーディングツール向けの AGENTS.md
 */
import type { TestCase } from "./testspec.js";

/* ------------------------------------------------------------------ */
/* テスト結果                                                           */
/* ------------------------------------------------------------------ */

export type TestResultStatus = "passed" | "failed" | "skipped";
export const TEST_RESULT_LABELS: Record<TestResultStatus, string> = { passed: "合格", failed: "不合格", skipped: "未実施（スキップ）" };

export interface RawTestResult {
  /** テストID（TC-FR-01-1）。なければ name から探す */
  testId?: string;
  /** テストツールでの名前（テストIDや要件IDを含めておくと結びつく） */
  name?: string;
  status: TestResultStatus;
  message?: string;
  durationMs?: number;
}

export class JUnitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JUnitParseError";
  }
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
    e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(parseInt(e.slice(1), 10)) : ENTITIES[e]!,
  );
const attrsOf = (s: string) => {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = decode(m[2] ?? m[3] ?? "");
  return out;
};
const textOf = (s: string) =>
  decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")).replace(/<[^>]+>/g, ""))
    .trim()
    .slice(0, 500);

export const JUNIT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * JUnit XML を読む。外部実体（DOCTYPE / ENTITY）は受け付けない。
 * <testsuites><testsuite><testcase name classname time><failure|error|skipped/></testcase>…
 */
export function parseJUnitXml(xml: string): Array<RawTestResult & { name: string; classname: string }> {
  if (xml.length > JUNIT_MAX_BYTES) throw new JUnitParseError("テスト結果が大きすぎます（10MBまで）");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new JUnitParseError("DOCTYPE・ENTITY を含む XML は受け付けません");
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const out: Array<RawTestResult & { name: string; classname: string }> = [];
  for (const m of body.matchAll(/<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrsOf(m[1] ?? "");
    const inner = m[3] ?? "";
    const fail = /<(failure|error)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(inner);
    const skipped = /<skipped\b/.test(inner);
    const status: TestResultStatus = fail ? "failed" : skipped ? "skipped" : "passed";
    const time = Number(a.time);
    out.push({
      name: a.name ?? "",
      classname: a.classname ?? "",
      status,
      message: fail ? (attrsOf(fail[2] ?? "").message || textOf(fail[4] ?? "")).slice(0, 500) : undefined,
      durationMs: Number.isFinite(time) ? Math.round(time * 1000) : undefined,
    });
  }
  if (!out.length && !/<testsuites?\b/.test(body)) throw new JUnitParseError("JUnit XML（testsuite / testcase）として読めません");
  return out;
}

const TEST_ID_RE = /\b(?:TC|AT)-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b/g;
const REQ_RE = /\b(?:BR|AC|FR|NFR|CN)-\d+\b/g;

export interface MatchedResults {
  /** テストケースに結びついた結果（同じテストが複数回あれば不合格を優先） */
  tests: Array<{ testId: string; status: TestResultStatus; message?: string; name?: string; durationMs?: number }>;
  /** テストIDはないが要件IDに結びついた結果 */
  requirements: Array<{ requirementCode: string; status: TestResultStatus; name: string; message?: string }>;
  /** どちらにも結びつかなかったテストの名前 */
  unmatched: string[];
}

const worse = (a: TestResultStatus, b: TestResultStatus): TestResultStatus => (a === "failed" || b === "failed" ? "failed" : a === "passed" || b === "passed" ? "passed" : "skipped");

/** 結果をテストケース・要件に結びつける。名前に含まれるIDは、知っているIDだけを使う */
export function matchResults(results: Array<RawTestResult & { classname?: string }>, knownTestIds: Iterable<string>, knownReqCodes: Iterable<string>): MatchedResults {
  const tests = new Set(knownTestIds);
  const reqs = new Set(knownReqCodes);
  const byTest = new Map<string, MatchedResults["tests"][number]>();
  const byReq: MatchedResults["requirements"] = [];
  const unmatched: string[] = [];
  for (const r of results) {
    const text = `${r.testId ?? ""} ${r.name ?? ""} ${r.classname ?? ""}`;
    const ids = [...new Set([...(r.testId ? [r.testId.trim()] : []), ...(text.match(TEST_ID_RE) ?? [])])].filter((x) => tests.has(x));
    if (ids.length) {
      for (const id of ids) {
        const prev = byTest.get(id);
        const status = prev ? worse(prev.status, r.status) : r.status;
        byTest.set(id, { testId: id, status, message: status === "failed" ? (r.status === "failed" ? r.message : prev?.message) : undefined, name: r.name, durationMs: r.durationMs });
      }
      continue;
    }
    const codes = [...new Set(text.match(REQ_RE) ?? [])].filter((x) => reqs.has(x));
    if (codes.length) {
      for (const c of codes) byReq.push({ requirementCode: c, status: r.status, name: r.name || r.testId || "", message: r.message });
      continue;
    }
    unmatched.push(r.name || r.testId || "（名前なし）");
  }
  return { tests: [...byTest.values()], requirements: byReq, unmatched };
}

/* ------------------------------------------------------------------ */
/* 状況の集計                                                           */
/* ------------------------------------------------------------------ */

export type ImplStatus = "not_started" | "in_progress" | "implemented" | "blocked";
export const IMPL_LABELS: Record<ImplStatus, string> = { not_started: "未着手", in_progress: "実装中", implemented: "実装済み", blocked: "止まっている" };

export interface ImplReport {
  requirementCode: string;
  status: ImplStatus;
  /** 報告したときの要件の版。いまの版より古ければ「要件が変わった」 */
  requirementVersion: number;
  refs: Array<{ label: string; url: string }>;
  note: string;
  reportedBy: string;
  at: string;
}

export interface TestRunLike {
  id: string;
  at: string;
  tests: MatchedResults["tests"];
  requirements: MatchedResults["requirements"];
}

export type ReqTestStatus = "passed" | "failed" | "partial" | "not_run";
export const REQ_TEST_LABELS: Record<ReqTestStatus, string> = { passed: "合格", failed: "不合格あり", partial: "一部未実施", not_run: "未実施" };

export interface RequirementStatusRow {
  code: string;
  type: string;
  title: string;
  version: number;
  impl: (ImplReport & { stale: boolean }) | null;
  tests: { total: number; passed: number; failed: number; skipped: number; notRun: number; status: ReqTestStatus; lastRunAt: string | null; failures: Array<{ testId: string; message?: string }> };
}

/** 各テストの最新の結果（新しい実行を優先） */
export function latestResults(runsNewestFirst: TestRunLike[]) {
  const tests = new Map<string, { status: TestResultStatus; message?: string; runId: string; at: string }>();
  const reqs = new Map<string, { status: TestResultStatus; runId: string; at: string }>();
  for (const run of runsNewestFirst) {
    for (const t of run.tests) if (!tests.has(t.testId)) tests.set(t.testId, { status: t.status, message: t.message, runId: run.id, at: run.at });
    const seen = new Map<string, TestResultStatus>();
    for (const r of run.requirements) seen.set(r.requirementCode, worse(seen.get(r.requirementCode) ?? r.status, r.status));
    for (const [code, status] of seen) if (!reqs.has(code)) reqs.set(code, { status, runId: run.id, at: run.at });
  }
  return { tests, reqs };
}

/** 要件ごとの実装状況とテスト結果 */
export function requirementStatus(
  reqs: Array<{ code: string; type: string; title: string; version: number }>,
  cases: TestCase[],
  impl: ImplReport[],
  runsNewestFirst: TestRunLike[],
): { rows: RequirementStatusRow[]; summary: Record<ImplStatus | "unreported" | "stale", number> & { tested: number; testPassed: number; testFailed: number } } {
  const lastImpl = new Map<string, ImplReport>();
  for (const r of [...impl].sort((a, b) => a.at.localeCompare(b.at))) lastImpl.set(r.requirementCode, r);
  const { tests, reqs: reqResults } = latestResults(runsNewestFirst);
  const rows: RequirementStatusRow[] = reqs.map((r) => {
    const mine = cases.filter((c) => c.requirementCode === r.code);
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let lastRunAt: string | null = null;
    const failures: Array<{ testId: string; message?: string }> = [];
    for (const c of mine) {
      const t = tests.get(c.id);
      if (!t) continue;
      if (t.status === "passed") passed++;
      else if (t.status === "failed") {
        failed++;
        failures.push({ testId: c.id, message: t.message });
      } else skipped++;
      if (!lastRunAt || t.at > lastRunAt) lastRunAt = t.at;
    }
    // テストIDのない結果（要件IDだけ）: テストIDの結果がなければ、要件そのものの結果として1件に数える。
    // テストIDの結果があるときは、不合格だけを足す（合格は個々のテストで数えているため）
    const rr = reqResults.get(r.code);
    let total = mine.length;
    if (rr) {
      const byId = passed + failed + skipped;
      if (!byId) {
        total = 1;
        if (rr.status === "passed") passed++;
        else if (rr.status === "skipped") skipped++;
      }
      if (rr.status === "failed") {
        failed++;
        if (byId) total++;
        failures.push({ testId: r.code });
      }
      if (!lastRunAt || rr.at > lastRunAt) lastRunAt = rr.at;
    }
    total = Math.max(total, passed + failed + skipped);
    const notRun = Math.max(0, total - passed - failed - skipped);
    const status: ReqTestStatus = failed ? "failed" : passed && !notRun && !skipped ? "passed" : passed ? "partial" : "not_run";
    const li = lastImpl.get(r.code);
    return { code: r.code, type: r.type, title: r.title, version: r.version, impl: li ? { ...li, stale: li.requirementVersion < r.version } : null, tests: { total, passed, failed, skipped, notRun, status, lastRunAt, failures } };
  });
  const summary = { not_started: 0, in_progress: 0, implemented: 0, blocked: 0, unreported: 0, stale: 0, tested: 0, testPassed: 0, testFailed: 0 };
  for (const r of rows) {
    if (r.impl) summary[r.impl.status]++;
    else summary.unreported++;
    if (r.impl?.stale) summary.stale++;
    if (r.tests.status !== "not_run") summary.tested++;
    if (r.tests.status === "passed") summary.testPassed++;
    if (r.tests.status === "failed") summary.testFailed++;
  }
  return { rows, summary };
}

/* ------------------------------------------------------------------ */
/* Gherkin（.feature）                                                 */
/* ------------------------------------------------------------------ */

const one = (s: string) => s.replace(/\s+/g, " ").trim();
const tag = (s: string) => `@${s.replace(/[\s@#]+/g, "_")}`;

const KIND_TAG: Record<string, string> = {
  normal: "正常系",
  negative: "条件を満たさない",
  abnormal: "異常系",
  "state-in": "状態の内",
  "state-out": "状態の外",
  "option-on": "機能あり",
  "option-off": "機能なし",
  boundary: "境界値",
  nfr: "非機能",
  acceptance: "受け入れ",
};

/** テストケースを Gherkin（日本語のキーワード）にする。要件ごと・ストーリーごとに1ファイル */
export function toGherkinFeatures(
  reqs: Array<{ code: string; type: string; title: string; version: number }>,
  cases: TestCase[],
  stories: Array<{ key: string; title: string; requirementCodes: string[] }> = [],
): Array<{ path: string; content: string }> {
  const head = (note: string) => ["# language: ja", `# 要件ナビが生成（${note}）。手で直さず、要件ナビで要件を直して作り直してください。`];
  const scenario = (c: TestCase) => {
    const lines = [
      `  ${tag(c.id)} ${tag(KIND_TAG[c.kind] ?? c.kind)}`,
      `  シナリオ: ${c.id} ${one(c.title)}`,
      `    前提 ${one(c.given)}`,
      `    もし ${one(c.when)}`,
      `    ならば ${one(c.then)}`,
    ];
    if (c.method) lines.push(`    # 確認方法: ${one(c.method)}`);
    return lines.join("\n");
  };
  const out: Array<{ path: string; content: string }> = [];
  for (const r of reqs) {
    const mine = cases.filter((c) => c.requirementCode === r.code && c.level !== "acceptance");
    if (!mine.length) continue;
    out.push({
      path: `tests/acceptance/${r.code}.feature`,
      content: [...head(`要件 ${r.code} 第${r.version}版`), tag(r.code), `機能: ${r.code} ${one(r.title).slice(0, 80)}`, `  ${one(r.title)}`, "", mine.map(scenario).join("\n\n"), ""].join("\n"),
    });
  }
  for (const s of stories) {
    const mine = cases.filter((c) => c.storyKey === s.key);
    if (!mine.length) continue;
    out.push({
      path: `tests/acceptance/stories/${s.key}.feature`,
      content: [...head(`ストーリー ${s.key} の受け入れ条件`), `${tag(s.key)} ${s.requirementCodes.map(tag).join(" ")}`.trim(), `機能: ${s.key} ${one(s.title)}`, "", mine.map(scenario).join("\n\n"), ""].join("\n"),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AGENTS.md（AIコーディングツール向けの作業の決まり）                    */
/* ------------------------------------------------------------------ */

export interface AgentsMdInput {
  projectName: string;
  purpose: string;
  projectId: string;
  serverUrl: string;
  baseline: { version: number; createdAt: string } | null;
  counts: Record<string, number>;
  verdict: string;
  openQuestions: string[];
  /** 決まっている主な非機能要件（「応答時間：3秒以内」など） */
  nfr: string[];
  files: string[];
}

export function renderAgentsMd(x: AgentsMdInput): string {
  const c = (t: string) => x.counts[t] ?? 0;
  return `# ${x.projectName}：AIコーディングツール向けの作業の決まり

このリポジトリの要件は **要件ナビ** で管理しています。このファイルと \`requirements/\`・\`tests/acceptance/\` は要件ナビが生成したものです。
要件を変えたいときは、これらのファイルを直さず、要件ナビで変更要求を出してください（確定版 ${x.baseline ? `第${x.baseline.version}版（${x.baseline.createdAt.slice(0, 10)}）` : "はまだありません"}）。

## 目的

${x.purpose || "（未記入）"}

## 要件

- 機能要件 ${c("FR")}件・非機能要件 ${c("NFR")}件・制約 ${c("CN")}件（目的 ${c("BR")}件・利用者 ${c("AC")}件）
- 要件文は EARS 記法です。「〜とき」はきっかけ、「〜間」は状態、「〜場合」は異常時、「〜がある場合」は任意の機能を表し、「〜しなければならない」の部分が満たすべき振る舞いです
- 一覧：\`requirements/requirements.md\`／設計の材料（データ項目定義・権限表・外部とのやり取り・図）：\`requirements/design.md\`／すべてを機械で読める形にしたもの：\`requirements/handoff.json\`
${x.nfr.length ? `\n### 守るべき主な非機能要件\n\n${x.nfr.map((n) => `- ${n}`).join("\n")}\n` : ""}
## 作業の決まり

1. **要件にない機能を作らない。** 要件があいまい・矛盾している・足りないと思ったら、推測で実装せず、要件ナビに質問してください（MCP の \`ask_question\`、または API の \`POST /api/v1/projects/{id}/questions\`）
2. **要件IDを書く。** コミットとプルリクエストに対応する要件ID（例：\`FR-03\`）を書いてください
3. **テストにテストIDを付ける。** \`tests/acceptance/*.feature\` のシナリオ、または同じテストIDをテスト名に含めてください（例：\`it("TC-FR-03-1 予約を確定すると確認メールを送る", …)\`）。テスト結果を要件に結びつけるのに使います
4. **データの名前は設計の材料に合わせる。** \`requirements/design.md\` の「コード上の名前」を使ってください（物理設計は変えてよいが、業務の言葉との対応は保つ）
5. **進み具合と結果を報告する。** 実装を始めたら・終えたら \`report_implementation\`、テストを実行したら \`report_test_results\`（または JUnit XML を API に送る）

## 要件ナビとの接続

- MCP サーバー：\`${x.serverUrl}/mcp\`（\`.mcp.json\` に設定済み。トークンは環境変数 \`ARN_TOKEN\` に入れてください）
- API：\`${x.serverUrl}/api/v1\`（定義：\`${x.serverUrl}/api/v1/openapi.json\`）
- プロジェクトID：\`${x.projectId}\`

## 引き継ぎ時点の状態

- 着手前チェック：${x.verdict}
${x.openQuestions.length ? `- 未決事項（着手前に確認すること）\n${x.openQuestions.map((q) => `  - ${q}`).join("\n")}` : "- 未決事項：なし"}

## このパッケージのファイル

${x.files.map((f) => `- \`${f}\``).join("\n")}
`;
}
