/**
 * 要件定義の確定後の変更・追加に対する影響分析（機能 F5-6）。
 *
 * 2つの方法を組み合わせる。
 * 1. トレース（機械的・確実）: 変更する要件コードから、ストーリー・画面・登録済みの課題をたどる
 * 2. AIによる分析（推測）: 関連する要件・設計（UML）の要素・画面・ストーリー・工数・リスク・代替案。
 *    複数のAIが使えるときは並列に分析し、何台のAIが同じ指摘をしたか（票数）を示す
 *
 * 結果には「要件定義を変更する／代替案で変更する／保留／変更しない」の選択肢と、それぞれの結果を添える。
 */
import { z } from "zod";
import { extractJson } from "./json.js";
import { ESTIMATES, type Estimate } from "./tasks.js";
import type { AIProvider, Usage } from "./types.js";

export type ChangeKind = "modify" | "add" | "delete";

export interface ChangeProposal {
  kind: ChangeKind;
  /** modify / delete の対象 */
  code: string | null;
  before: { title: string; description: string; priority: string } | null;
  /** modify / add の変更後 */
  after: { title: string; description: string; priority: string; type: string } | null;
  reason: string;
}

export interface ImpactContext {
  projectName: string;
  requirements: Array<{ code: string; type: string; title: string; priority?: string }>;
  stories: Array<{ key: string; title: string; requirementCodes: string[]; estimate: Estimate; links: Array<{ url?: string; externalKey?: string; integration?: string }> }>;
  screens: Array<{ key: string; name: string; requirementCodes: string[] }>;
  /** 採用したUMLの要約（summarizeUmlModel） */
  design: string;
  /** UMLの要素名（クラス名・シーケンス名など）。AIの指摘を実在するものに絞るため */
  designElements: string[];
}

const estimate = z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(["S", "M", "L"]).catch("M"));
export const ImpactContent = z.object({
  summary: z.string().min(1).max(1000),
  relatedRequirementCodes: z.array(z.string()).max(50).default([]),
  designElements: z.array(z.string()).max(50).default([]),
  screens: z.array(z.string()).max(50).default([]),
  stories: z.array(z.string()).max(100).default([]),
  effort: estimate.default("M"),
  risks: z.array(z.string().min(1).max(300)).max(10).default([]),
  alternative: z
    .object({ title: z.string().min(1).max(100), description: z.string().max(1000).default("") })
    .nullable()
    .default(null),
});
export type ImpactContent = z.infer<typeof ImpactContent>;

export const IMPACT_SYSTEM = `あなたはシステム開発の変更管理の担当者です。確定済みの要件定義に対する変更要求が、後の工程（設計・画面・実装タスク・登録済みの課題）にどう影響するかを影響分析します。
- relatedRequirementCodes: この変更で見直しが必要になる既存の要件コード（変更対象そのものを含む）。存在しないコードは書かない
- designElements: 見直しが必要なUMLの要素名（「設計」に出てくる名前のみ）
- screens: 見直しが必要な画面のキー（S01 など）。stories: 見直しが必要なストーリーのキー（E1-S2 など）
- effort: 変更にかかる追加の工数の目安 S（1〜2日）/ M（3〜5日）/ L（1〜2週間以上）
- risks: 変更によって起こりうる問題（既存データ、他の機能との矛盾、スケジュール、テストのやり直しなど）
- alternative: 要件を変えずに目的を果たせる代替案、またはより影響の小さい変更案があれば1つ。なければ null
- 専門用語を避け、業務の担当者が判断できる言葉で書く
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{ "summary": "...", "relatedRequirementCodes": ["FR-01"], "designElements": ["..."], "screens": ["S01"], "stories": ["E1-S1"], "effort": "M", "risks": ["..."], "alternative": { "title": "...", "description": "..." } }`;

const KIND_LABEL: Record<ChangeKind, string> = { modify: "変更", add: "追加", delete: "削除" };

export function buildImpactPrompt(change: ChangeProposal, ctx: ImpactContext): string {
  const lines: string[] = [`# 変更要求（${KIND_LABEL[change.kind]}）`];
  if (change.code) lines.push(`対象の要件: ${change.code}`);
  if (change.before) lines.push(`変更前: ${change.before.title}${change.before.description ? ` — ${change.before.description}` : ""}（優先度 ${change.before.priority}）`);
  if (change.after) lines.push(`変更後: [${change.after.type}] ${change.after.title}${change.after.description ? ` — ${change.after.description}` : ""}（優先度 ${change.after.priority}）`);
  lines.push(`理由: ${change.reason || "（未記入）"}`);
  return `${lines.join("\n")}

# 確定済みの要件
${ctx.requirements.map((r) => `- ${r.code} [${r.type}] ${r.title}`).join("\n") || "（なし）"}

# 設計（UML）
${ctx.design || "（未作成）"}

# 画面
${ctx.screens.map((s) => `- ${s.key} ${s.name} [${s.requirementCodes.join(",")}]`).join("\n") || "（未作成）"}

# 実装タスク（ストーリー）
${ctx.stories.map((s) => `- ${s.key} ${s.title} [${s.requirementCodes.join(",")}] 見積り${s.estimate}${s.links.length ? " 課題登録済み" : ""}`).join("\n") || "（未作成）"}`;
}

/* ------------------------------------------------------------------ */
/* 結果                                                                */
/* ------------------------------------------------------------------ */

export interface Voted<T> {
  item: T;
  /** 指摘したAIの数 */
  votes: number;
  /** トレース（機械的）でも見つかったか */
  traced: boolean;
}

export type ImpactOptionKey = "apply" | "alternative" | "defer" | "reject";
export interface ImpactOption {
  key: ImpactOptionKey;
  label: string;
  /** 選んだときに起きること */
  consequence: string;
}

export interface ImpactReport {
  change: ChangeProposal;
  /** 分析したAIの数（0ならトレースのみ） */
  analysts: number;
  summaries: Array<{ providerId: string; summary: string }>;
  failures: Array<{ providerId: string; reason: string }>;
  requirements: Array<Voted<{ code: string; title: string }>>;
  design: Array<Voted<{ name: string }>>;
  screens: Array<Voted<{ key: string; name: string }>>;
  stories: Array<Voted<{ key: string; title: string; points: number }>>;
  /** 見直しが必要な登録済みの課題（ストーリーからたどる） */
  issues: Array<{ storyKey: string; externalKey?: string; url?: string; integration?: string }>;
  effort: Estimate;
  risks: string[];
  alternatives: Array<{ providerId: string; title: string; description: string }>;
  /** 影響の大きさの目安 */
  scale: "small" | "medium" | "large";
  points: number;
  options: ImpactOption[];
}

export interface ImpactAnalysisResult {
  report: ImpactReport;
  usages: Array<{ providerId: string; usage: Usage }>;
}

const EFFORT_ORDER: Estimate[] = ["S", "M", "L"];

/** トレースとAIの分析をまとめ、選択肢を作る（AIなしでも動く） */
export function buildImpactReport(
  change: ChangeProposal,
  ctx: ImpactContext,
  analyses: Array<{ providerId: string; content: ImpactContent }>,
  failures: ImpactReport["failures"] = [],
): ImpactReport {
  const reqTitle = new Map(ctx.requirements.map((r) => [r.code, r.title]));
  const storyBy = new Map(ctx.stories.map((s) => [s.key, s]));
  const screenBy = new Map(ctx.screens.map((s) => [s.key, s]));
  const designNames = new Set(ctx.designElements);

  // 1. トレース
  const seed = new Set<string>(change.code ? [change.code] : []);
  // 追加の場合は、AIが関連すると判断した要件をたどりの起点にする（半数以上のAIが指摘したもの）
  const count = (pick: (c: ImpactContent) => string[]) => {
    const m = new Map<string, number>();
    for (const a of analyses) for (const x of new Set(pick(a.content).map((v) => v.trim()))) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const reqVotes = count((c) => c.relatedRequirementCodes);
  const majority = Math.max(1, Math.ceil(analyses.length / 2));
  if (change.kind === "add") for (const [code, v] of reqVotes) if (v >= majority && reqTitle.has(code)) seed.add(code);
  const tracedStories = ctx.stories.filter((s) => s.requirementCodes.some((c) => seed.has(c)));
  const tracedScreens = ctx.screens.filter((s) => s.requirementCodes.some((c) => seed.has(c)));

  // 2. AIの指摘（実在するものだけ）と票数
  const storyVotes = count((c) => c.stories);
  const screenVotes = count((c) => c.screens);
  const designVotes = count((c) => c.designElements);

  const requirements: ImpactReport["requirements"] = [];
  const reqCodes = new Set([...seed, ...[...reqVotes.keys()].filter((c) => reqTitle.has(c))]);
  for (const code of reqCodes) {
    requirements.push({ item: { code, title: reqTitle.get(code) ?? "" }, votes: reqVotes.get(code) ?? 0, traced: change.code === code });
  }
  const stories: ImpactReport["stories"] = [];
  for (const key of new Set([...tracedStories.map((s) => s.key), ...[...storyVotes.keys()].filter((k) => storyBy.has(k))])) {
    const s = storyBy.get(key)!;
    stories.push({ item: { key, title: s.title, points: ESTIMATES[s.estimate].points }, votes: storyVotes.get(key) ?? 0, traced: tracedStories.includes(s) });
  }
  const screens: ImpactReport["screens"] = [];
  for (const key of new Set([...tracedScreens.map((s) => s.key), ...[...screenVotes.keys()].filter((k) => screenBy.has(k))])) {
    screens.push({ item: { key, name: screenBy.get(key)!.name }, votes: screenVotes.get(key) ?? 0, traced: tracedScreens.some((s) => s.key === key) });
  }
  const design: ImpactReport["design"] = [...designVotes]
    .filter(([n]) => designNames.has(n))
    .map(([name, votes]) => ({ item: { name }, votes, traced: false }));
  const byWeight = <T>(a: Voted<T>, b: Voted<T>) => Number(b.traced) - Number(a.traced) || b.votes - a.votes;
  requirements.sort(byWeight);
  stories.sort(byWeight);
  screens.sort(byWeight);
  design.sort(byWeight);

  const issues = stories.flatMap((s) => (storyBy.get(s.item.key)?.links ?? []).map((l) => ({ storyKey: s.item.key, ...l })));
  const effort = analyses.reduce<Estimate>((m, a) => (EFFORT_ORDER.indexOf(a.content.effort) > EFFORT_ORDER.indexOf(m) ? a.content.effort : m), "S");
  const risks = [...new Set(analyses.flatMap((a) => a.content.risks.map((r) => r.trim())))].slice(0, 10);
  const alternatives = analyses.filter((a) => a.content.alternative).map((a) => ({ providerId: a.providerId, ...a.content.alternative! }));
  const points = stories.reduce((a, s) => a + s.item.points, 0);
  const touched = stories.length + screens.length + design.length + issues.length;
  const scale = effort === "L" || touched >= 10 ? "large" : effort === "M" || touched >= 4 ? "medium" : "small";

  const work = [
    design.length ? `設計（UML）${design.length}か所` : "",
    screens.length ? `画面 ${screens.length}件` : "",
    stories.length ? `ストーリー ${stories.length}件（${points}ポイント分）` : "",
    issues.length ? `登録済みの課題 ${issues.length}件` : "",
  ].filter(Boolean);
  const applyLabel = { modify: "要件定義を変更する", add: "要件を追加する", delete: "要件を削除する" }[change.kind];
  const options: ImpactOption[] = [
    {
      key: "apply",
      label: applyLabel,
      consequence: `要件定義の版を上げて記録します。${work.length ? `${work.join("・")}の見直しが必要になります。` : "後の工程への影響は見つかっていません。"}追加の工数の目安は ${ESTIMATES[effort].label} です。`,
    },
  ];
  if (alternatives.length && change.kind !== "delete") {
    options.push({
      key: "alternative",
      label: `代替案で対応する（${alternatives[0]!.title}）`,
      consequence: "代替案の内容で要件を変更・追加します。影響は代替案の内容によって変わるため、必要なら代替案で分析し直してください。",
    });
  }
  options.push(
    { key: "defer", label: "保留する（次の段階で検討）", consequence: "今の要件定義のまま進めます。変更要求は保留の一覧に残り、後から分析し直して判断できます。" },
    { key: "reject", label: "変更しない", consequence: "今の要件定義のまま進めます。判断の理由を記録して終了します。" },
  );

  return {
    change,
    analysts: analyses.length,
    summaries: analyses.map((a) => ({ providerId: a.providerId, summary: a.content.summary })),
    failures,
    requirements,
    design,
    screens,
    stories,
    issues,
    effort,
    risks,
    alternatives,
    scale,
    points,
    options,
  };
}

/** 使えるAIすべてで並列に分析する（失敗したAIは除いて続ける。すべて失敗してもトレースの結果は返す） */
export async function analyzeImpact(
  providers: AIProvider[],
  change: ChangeProposal,
  ctx: ImpactContext,
  opts: { timeoutMs?: number; onProgress?: (providerId: string, status: "running" | "done" | "failed", reason?: string) => void } = {},
): Promise<ImpactAnalysisResult> {
  const prompt = buildImpactPrompt(change, ctx);
  const settled = await Promise.all(
    providers.map(async (p) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
      opts.onProgress?.(p.id, "running");
      try {
        const res = await p.complete({ system: IMPACT_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, maxTokens: 4000, signal: ctrl.signal });
        const content = ImpactContent.parse(extractJson(res.text));
        opts.onProgress?.(p.id, "done");
        return { ok: true as const, providerId: p.id, content, usage: res.usage };
      } catch (e) {
        const reason = ctrl.signal.aborted ? "時間内に応答がありませんでした" : (e as Error).message;
        opts.onProgress?.(p.id, "failed", reason);
        return { ok: false as const, providerId: p.id, reason };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const ok = settled.filter((s): s is Extract<(typeof settled)[number], { ok: true }> => s.ok);
  const failures = settled.filter((s) => !s.ok).map((s) => ({ providerId: s.providerId, reason: (s as { reason: string }).reason }));
  return {
    report: buildImpactReport(
      change,
      ctx,
      ok.map((s) => ({ providerId: s.providerId, content: s.content })),
      failures,
    ),
    usages: ok.map((s) => ({ providerId: s.providerId, usage: s.usage })),
  };
}

/** UMLモデルから要素名を集める（影響分析の指摘を実在する要素に絞るため） */
export function designElementNames(model: {
  classes: Array<{ name: string; label?: string }>;
  sequences: Array<{ title: string }>;
  stateMachines: Array<{ entity: string }>;
  activities: Array<{ title: string }>;
}): string[] {
  return [
    ...model.classes.flatMap((c) => [c.name, ...(c.label ? [c.label] : [])]),
    ...model.sequences.map((s) => s.title),
    ...model.stateMachines.map((s) => s.entity),
    ...model.activities.map((a) => a.title),
  ];
}
