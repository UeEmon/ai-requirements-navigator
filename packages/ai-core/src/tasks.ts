/**
 * 実装工程への連携（機能 F7-1 / F7-2）。
 * 確定した要件（と採用したUML設計）から、エピック → ストーリー → 作業タスクに分解する。
 * 各ストーリーには元になった要件コードを持たせ、要件 → 課題のトレーサビリティを保つ。
 * 出力は Markdown / Jira CSV / Backlog CSV / JSON と、課題管理ツールに登録する本文。
 */
import { z } from "zod";
import { extractJson } from "./json.js";
import type { AIProvider, Usage } from "./types.js";

export const TASK_KINDS = {
  frontend: "画面",
  backend: "サーバー",
  db: "データベース",
  infra: "基盤",
  test: "テスト",
  doc: "文書",
  other: "その他",
} as const;
export type TaskKind = keyof typeof TASK_KINDS;

export const ESTIMATES = { S: { label: "小（1〜2日）", points: 2 }, M: { label: "中（3〜5日）", points: 5 }, L: { label: "大（1〜2週間）", points: 8 } } as const;
export type Estimate = keyof typeof ESTIMATES;

const codes = z.array(z.string()).default([]);
const kind = z.preprocess(
  (v) => (typeof v === "string" && v in TASK_KINDS ? v : "other"),
  z.enum(["frontend", "backend", "db", "infra", "test", "doc", "other"]),
);
const estimate = z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(["S", "M", "L"]).catch("M"));

/** AIが返す形（キーはこちらで振る） */
export const TaskPlanContent = z.object({
  epics: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).default(""),
        stories: z
          .array(
            z.object({
              title: z.string().min(1).max(200),
              description: z.string().max(4000).default(""),
              acceptanceCriteria: z.array(z.string().min(1).max(500)).max(15).default([]),
              requirementCodes: codes,
              estimate: estimate.default("M"),
              tasks: z.array(z.object({ title: z.string().min(1).max(200), kind: kind.default("other") })).max(20).default([]),
            }),
          )
          .min(1)
          .max(40),
      }),
    )
    .min(1)
    .max(20),
});
export type TaskPlanContent = z.infer<typeof TaskPlanContent>;

export interface PlanTask {
  title: string;
  kind: TaskKind;
}
export interface PlanStory {
  /** 例: E1-S2。外部登録やトレーサビリティの照合に使う */
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requirementCodes: string[];
  estimate: Estimate;
  tasks: PlanTask[];
}
export interface PlanEpic {
  key: string;
  title: string;
  description: string;
  /** 配下のストーリーが対応する要件（重複なし） */
  requirementCodes: string[];
  stories: PlanStory[];
}
export interface TaskPlan {
  epics: PlanEpic[];
  /** どのストーリーにも対応しない要件（機能要件・非機能要件のみ） */
  uncovered: string[];
  /** AIが出した存在しない要件コード */
  unknownCodes: string[];
}

export interface TaskRequirement {
  code: string;
  type: string;
  title: string;
  description?: string;
  priority?: string;
}

/** 実装タスクで対応すべき要件の区分（業務要件・制約は文脈として渡すだけ） */
export const TASK_TARGET_TYPES = ["FR", "NFR"];

/** コードを振り、存在しない要件コードを取り除き、未対応の要件を調べる */
export function normalizeTaskPlan(content: TaskPlanContent, reqs: TaskRequirement[]): TaskPlan {
  const known = new Set(reqs.map((r) => r.code));
  const unknown = new Set<string>();
  const used = new Set<string>();
  const uniq = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);
  const epics: PlanEpic[] = content.epics.map((e, ei) => {
    const stories: PlanStory[] = e.stories.map((s, si) => {
      const rc = uniq(s.requirementCodes.map((c) => c.trim())).filter((c) => {
        if (known.has(c)) return true;
        if (c) unknown.add(c);
        return false;
      });
      rc.forEach((c) => used.add(c));
      return {
        key: `E${ei + 1}-S${si + 1}`,
        title: s.title.trim(),
        description: s.description.trim(),
        acceptanceCriteria: s.acceptanceCriteria.map((a) => a.trim()).filter(Boolean),
        requirementCodes: rc,
        estimate: s.estimate,
        tasks: s.tasks.map((t) => ({ title: t.title.trim(), kind: t.kind })),
      };
    });
    return {
      key: `E${ei + 1}`,
      title: e.title.trim(),
      description: e.description.trim(),
      requirementCodes: uniq(stories.flatMap((s) => s.requirementCodes)),
      stories,
    };
  });
  const uncovered = reqs.filter((r) => TASK_TARGET_TYPES.includes(r.type) && !used.has(r.code)).map((r) => r.code);
  return { epics, uncovered, unknownCodes: [...unknown] };
}

export const TASK_SYSTEM = `あなたは経験豊富なテックリードです。確定した要件を、開発チームがそのまま着手できる単位に分解します。
- エピック（大きな機能のまとまり）→ ストーリー（利用者に価値が届く単位、数日で終わる大きさ）→ タスク（作業）の3段階にする
- すべての機能要件（FR）と非機能要件（NFR）が、いずれかのストーリーの requirementCodes に入るようにする。存在しない要件コードは使わない
- 非機能要件は、関係する機能のストーリーの受け入れ条件に含めるか、独立したストーリーにする
- acceptanceCriteria は「〜できる」「〜秒以内に表示される」など、テストで確かめられる文にする
- estimate は S（1〜2日）/ M（3〜5日）/ L（1〜2週間）。L を超えるならストーリーを分ける
- tasks の kind は frontend / backend / db / infra / test / doc / other のいずれか。各ストーリーにテストのタスクを含める
- 要件にない機能を作り込まない
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{ "epics": [{ "title": "...", "description": "...", "stories": [{ "title": "...", "description": "...", "acceptanceCriteria": ["..."], "requirementCodes": ["FR-01"], "estimate": "M", "tasks": [{ "title": "...", "kind": "backend" }] }] }] }`;

export function buildTaskPrompt(projectName: string, purpose: string, reqs: TaskRequirement[], design = ""): string {
  const line = (r: TaskRequirement) =>
    `- ${r.code} [${r.type}${r.priority ? `/${r.priority}` : ""}] ${r.title}${r.description ? ` — ${r.description.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
  return `# プロジェクト
名称: ${projectName}
目的: ${purpose || "（未記入）"}

# 要件
${reqs.map(line).join("\n") || "（なし）"}
${design ? `\n# 採用した設計（UML）\n${design}\n` : ""}`;
}

export interface TaskPlanResult {
  plan: TaskPlan;
  providerId: string;
  usage: Usage;
  failures: Array<{ providerId: string; reason: string }>;
}

/** 指定順にAIを試し、最初に検証を通った分解結果を返す */
export async function generateTaskPlan(
  providers: AIProvider[],
  projectName: string,
  purpose: string,
  reqs: TaskRequirement[],
  opts: { design?: string; timeoutMs?: number } = {},
): Promise<TaskPlanResult> {
  const failures: TaskPlanResult["failures"] = [];
  const prompt = buildTaskPrompt(projectName, purpose, reqs, opts.design);
  for (const p of providers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const res = await p.complete({ system: TASK_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, maxTokens: 12000, signal: ctrl.signal });
      const plan = normalizeTaskPlan(TaskPlanContent.parse(extractJson(res.text)), reqs);
      if (!plan.epics.some((e) => e.stories.length)) throw new Error("ストーリーがありません");
      return { plan, providerId: p.id, usage: res.usage, failures };
    } catch (e) {
      failures.push({ providerId: p.id, reason: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error("タスクに分解できませんでした") as Error & { failures: typeof failures };
  err.failures = failures;
  throw err;
}

/* ------------------------------------------------------------------ */
/* 出力                                                                */
/* ------------------------------------------------------------------ */

export type BodyFormat = "markdown" | "jira";

/** 課題管理ツールに登録するストーリーの本文 */
export function storyBody(
  story: PlanStory,
  epic: PlanEpic,
  reqs: TaskRequirement[],
  format: BodyFormat = "markdown",
  opts: { checklist?: boolean } = {},
): string {
  const h = (t: string) => (format === "jira" ? `h3. ${t}` : `### ${t}`);
  const li = (t: string) => (format === "jira" ? `* ${t}` : `- ${t}`);
  const box = (t: string) => (format === "markdown" && opts.checklist !== false ? `- [ ] ${t}` : li(t));
  const title = new Map(reqs.map((r) => [r.code, r.title]));
  const out: string[] = [];
  if (story.description) out.push(story.description, "");
  if (story.acceptanceCriteria.length) out.push(h("受け入れ条件"), ...story.acceptanceCriteria.map(box), "");
  if (story.tasks.length) out.push(h("タスク"), ...story.tasks.map((t) => box(`[${TASK_KINDS[t.kind]}] ${t.title}`)), "");
  if (story.requirementCodes.length) {
    out.push(h("関連する要件"), ...story.requirementCodes.map((c) => li(`${c} ${title.get(c) ?? ""}`.trim())), "");
  }
  out.push(`見積り: ${ESTIMATES[story.estimate].label} ／ エピック: ${epic.key} ${epic.title} ／ ストーリー: ${story.key}`);
  out.push("（要件ナビから登録）");
  return out.join("\n");
}

export function epicBody(epic: PlanEpic, format: BodyFormat = "markdown"): string {
  const li = (t: string) => (format === "jira" ? `* ${t}` : `- ${t}`);
  return [
    epic.description,
    "",
    format === "jira" ? "h3. ストーリー" : "### ストーリー",
    ...epic.stories.map((s) => li(`${s.key} ${s.title}`)),
    "",
    `関連する要件: ${epic.requirementCodes.join(", ") || "なし"}`,
    "（要件ナビから登録）",
  ].join("\n");
}

export function toTaskMarkdown(plan: TaskPlan, projectName: string, reqs: TaskRequirement[]): string {
  const out = [`# ${projectName} 実装タスク`, ""];
  const stories = plan.epics.flatMap((e) => e.stories);
  const points = stories.reduce((a, s) => a + ESTIMATES[s.estimate].points, 0);
  out.push(`エピック ${plan.epics.length} ／ ストーリー ${stories.length} ／ 見積りポイント合計 ${points}`, "");
  if (plan.uncovered.length) out.push(`> 注意: 次の要件に対応するストーリーがありません: ${plan.uncovered.join(", ")}`, "");
  for (const e of plan.epics) {
    out.push(`## ${e.key} ${e.title}`, "");
    if (e.description) out.push(e.description, "");
    for (const s of e.stories) {
      out.push(`### ${s.key} ${s.title}（${s.estimate}）`, "");
      out.push(storyBody(s, e, reqs).split("\n").filter((l) => !l.startsWith("見積り:") && l !== "（要件ナビから登録）").join("\n").trim(), "");
    }
  }
  out.push("## 要件との対応", "", "| 要件 | ストーリー |", "| --- | --- |");
  for (const r of reqs.filter((x) => TASK_TARGET_TYPES.includes(x.type))) {
    const ss = stories.filter((s) => s.requirementCodes.includes(r.code)).map((s) => s.key);
    out.push(`| ${r.code} ${r.title.replace(/\|/g, "\\|")} | ${ss.join(", ") || "**未対応**"} |`);
  }
  return out.join("\n") + "\n";
}

/** 表計算ソフトで式として解釈されないようにする（CSVインジェクション対策） */
function cell(v: string | number): string {
  let s = String(v);
  if (/^[=+@\t\r]/.test(s) || /^-(?!\s)/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
function csv(rows: Array<Array<string | number>>): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Jira の CSV インポート用。Issue Id / Parent Id で階層を表す
 * （インポート時に Issue Id・Parent Id・Issue Type を対応付ける）。
 */
export function toJiraCsv(plan: TaskPlan, reqs: TaskRequirement[]): string {
  const rows: Array<Array<string | number>> = [["Issue Id", "Parent Id", "Issue Type", "Summary", "Description", "Story Points", "Labels"]];
  let id = 1;
  for (const e of plan.epics) {
    const eid = id++;
    rows.push([eid, "", "Epic", e.title, epicBody(e, "jira"), "", "requirements-navigator"]);
    for (const s of e.stories) {
      const sid = id++;
      rows.push([sid, eid, "Story", s.title, storyBody(s, e, reqs, "jira"), ESTIMATES[s.estimate].points, "requirements-navigator"]);
      for (const t of s.tasks) rows.push([id++, sid, "Sub-task", t.title, `[${TASK_KINDS[t.kind]}] ${s.key}`, "", "requirements-navigator"]);
    }
  }
  return csv(rows);
}

/**
 * Backlog の課題一括登録（CSV）用。親子関係はCSVでは指定できないため、
 * エピックを「カテゴリー名」に、タスクを本文のチェックリストにする。
 */
export function toBacklogCsv(plan: TaskPlan, reqs: TaskRequirement[]): string {
  const rows: Array<Array<string | number>> = [["件名", "詳細", "種別", "カテゴリー名", "優先度", "予定時間"]];
  const hours = { S: 12, M: 32, L: 64 } as const;
  for (const e of plan.epics) {
    for (const s of e.stories) rows.push([`${s.key} ${s.title}`, storyBody(s, e, reqs), "タスク", e.title, "中", hours[s.estimate]]);
  }
  return csv(rows);
}

/** トレーサビリティ：要件ごとの対応ストーリー */
export function traceRequirements(plan: TaskPlan, reqs: TaskRequirement[]) {
  const stories = plan.epics.flatMap((e) => e.stories.map((s) => ({ ...s, epicKey: e.key, epicTitle: e.title })));
  return reqs.map((r) => ({
    code: r.code,
    type: r.type,
    title: r.title,
    target: TASK_TARGET_TYPES.includes(r.type),
    stories: stories.filter((s) => s.requirementCodes.includes(r.code)).map((s) => ({ key: s.key, title: s.title, epicKey: s.epicKey })),
  }));
}
