/**
 * 質問ガイド（機能 F2-2 / F2-3 / F2-5）。
 * フェーズの観点（チェックリスト）に対して、確定済みの要件で何が埋まり何が足りないかをAIが判定し、
 * 足りない観点を埋めるための次の質問・回答候補・用語解説を作る。
 * AIが使えない・失敗したときは、フェーズ既定の質問と候補を返す（画面が止まらないように）。
 */
import { z } from "zod";
import { findGlossary, type GlossaryEntry } from "./glossary.js";
import { extractJson } from "./json.js";
import type { Phase } from "./phases.js";
import type { AIProvider, Usage } from "./types.js";

export const GuideContent = z.object({
  question: z.string().min(1).max(300),
  hint: z.string().max(300).default(""),
  options: z.array(z.string().min(1).max(120)).max(6).default([]),
  glossary: z.array(z.object({ term: z.string().min(1).max(40), explanation: z.string().min(1).max(200) })).max(8).default([]),
  coveredPoints: z.array(z.string()).default([]),
});
export type GuideContent = z.infer<typeof GuideContent>;

export interface Guide {
  phaseKey: string;
  question: string;
  hint: string;
  options: string[];
  glossary: GlossaryEntry[];
  /** 観点ごとの網羅状況 */
  covered: string[];
  missing: string[];
  /** 0〜1 */
  coverage: number;
  source: "ai" | "default";
  providerId: string | null;
  /** 生成時点のこのフェーズの要件数（古くなったかの判定に使う） */
  requirementCount: number;
}

export interface GuideContext {
  phase: Phase;
  projectName: string;
  projectPurpose: string;
  /** このフェーズで確定した要件 */
  phaseRequirements: Array<{ code: string; title: string }>;
  /** 他のフェーズで確定した要件（文脈として渡す） */
  otherRequirements: Array<{ code: string; title: string }>;
}

export const GUIDE_SYSTEM = `あなたは要件定義のインタビュアーで、システム開発に詳しくない利用者から要件を引き出すための質問を設計します。
- 「確認すべき観点」のうち、確定済みの要件で十分に埋まっているものを coveredPoints に観点の文字列そのままで入れる。曖昧なものは埋まっていないとする
- 埋まっていない観点を1つ選び、それを引き出す質問を1つ作る。専門用語を避け、具体的な場面を思い浮かべられる言い方にする
- options は利用者がそのまま選べる回答例を3〜5個。この業務に合った具体的な内容にする
- glossary は question・hint・options に出てくる専門用語だけを、平易な言葉で説明する
- すべての観点が埋まっている場合は、確認や補足を促す質問にする
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{ "question": "...", "hint": "答え方のヒント", "options": ["..."], "glossary": [{ "term": "...", "explanation": "..." }], "coveredPoints": ["..."] }`;

export function buildGuidePrompt(ctx: GuideContext): string {
  const list = (rs: GuideContext["phaseRequirements"]) => rs.map((r) => `- ${r.code} ${r.title}`).join("\n") || "（まだありません）";
  return `# プロジェクト
名称: ${ctx.projectName}
目的: ${ctx.projectPurpose || "（未記入）"}

# 現在のフェーズ
${ctx.phase.name}

# 確認すべき観点
${ctx.phase.checklist.map((c) => `- ${c}`).join("\n")}

# このフェーズで確定した要件
${list(ctx.phaseRequirements)}

# 他のフェーズで確定した要件
${list(ctx.otherRequirements)}`;
}

function finish(ctx: GuideContext, c: GuideContent, source: Guide["source"], providerId: string | null): Guide {
  const covered = ctx.phase.checklist.filter((p) => c.coveredPoints.includes(p));
  const missing = ctx.phase.checklist.filter((p) => !covered.includes(p));
  return {
    phaseKey: ctx.phase.key,
    question: c.question,
    hint: c.hint,
    options: c.options,
    glossary: findGlossary([c.question, c.hint, ...c.options], c.glossary),
    covered,
    missing,
    coverage: ctx.phase.checklist.length ? covered.length / ctx.phase.checklist.length : 1,
    source,
    providerId,
    requirementCount: ctx.phaseRequirements.length,
  };
}

/** AIを使わない既定のガイド。要件がない観点はすべて未確認として扱う */
export function defaultGuide(ctx: GuideContext): Guide {
  return finish(
    ctx,
    { question: ctx.phase.question, hint: ctx.phase.hint, options: ctx.phase.defaultOptions, glossary: [], coveredPoints: [] },
    "default",
    null,
  );
}

export interface GuideResult {
  guide: Guide;
  usage: Usage | null;
  failures: Array<{ providerId: string; reason: string }>;
}

/** 指定順にAIを試す。すべて失敗したら既定のガイドを返す */
export async function generateGuide(providers: AIProvider[], ctx: GuideContext, timeoutMs = 60_000): Promise<GuideResult> {
  const failures: GuideResult["failures"] = [];
  const prompt = buildGuidePrompt(ctx);
  for (const p of providers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await p.complete({ system: GUIDE_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, maxTokens: 2000, signal: ctrl.signal });
      const c = GuideContent.parse(extractJson(res.text));
      return { guide: finish(ctx, c, "ai", p.id), usage: res.usage, failures };
    } catch (e) {
      failures.push({ providerId: p.id, reason: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  return { guide: defaultGuide(ctx), usage: null, failures };
}
