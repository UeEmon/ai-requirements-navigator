import { EARS_INSTRUCTIONS, EARS_SHAPE } from "./ears.js";
import type { Phase } from "./phases.js";
import type { CandidateContent, RequirementItem } from "./schema.js";

export interface PromptContext {
  phase: Phase;
  projectName: string;
  projectPurpose: string;
  existingRequirements: Array<RequirementItem & { code?: string }>;
  userAnswer: string;
}

const CANDIDATE_SHAPE = `{
  "items": [
    { "title": "要件を1文で", "description": "補足（任意）", "type": "BR|AC|FR|NFR|CN", "priority": "must|should|could", ${EARS_SHAPE} }
  ],
  "questions": ["利用者に追加で確認したいこと（任意）"],
  "notes": "前提や注意点（任意）"
}`;

export const GENERATOR_SYSTEM = `あなたは要件定義の専門家です。システム開発に詳しくない利用者の回答から、要件を整理します。
- 利用者の言葉を尊重し、推測で機能を広げすぎない
- 1項目は1文で、検証できる書き方にする（「速い」ではなく「3秒以内」など。数値が不明なら questions で確認する）
- 既存の要件と重複・矛盾する項目は出さない
${EARS_INSTRUCTIONS}
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
${CANDIDATE_SHAPE}`;

export function buildGeneratorPrompt(ctx: PromptContext): string {
  const existing = ctx.existingRequirements.length
    ? ctx.existingRequirements.map((r) => `- ${r.code ?? r.type} ${r.title}`).join("\n")
    : "（まだありません）";
  return `# プロジェクト
名称: ${ctx.projectName}
目的: ${ctx.projectPurpose}

# 現在のフェーズ
${ctx.phase.name}（主に作る要件の区分: ${ctx.phase.type}）
確認すべき観点: ${ctx.phase.checklist.join("、")}

# 確定済みの要件
${existing}

# 利用者への質問
${ctx.phase.question}

# 利用者の回答
${ctx.userAnswer}

上の回答から、このフェーズの要件案を作ってください。`;
}

export const EVALUATOR_SYSTEM = `あなたは要件定義のレビュアーです。複数の要件案を、提供元を知らされずに比較評価します。
評価基準（各0〜100点）:
- coverage（網羅性）: 必要な要件・例外ケースが揃っているか
- accuracy（正確性）: 業務・技術的に誤りがないか
- consistency（一貫性）: 確定済みの要件と矛盾しないか
- feasibility（実現可能性）: 実装できる粒度・内容か
- clarity（分かりやすさ）: 専門家でない利用者が理解できるか
さらに、各案の良い項目を重複なく組み合わせた統合案（merged）を作ってください。統合案の書き方は次のとおり。
${EARS_INSTRUCTIONS}
出力は次の形のJSONのみ。説明文やコードフェンスは付けない:
{
  "scores": { "A": { "coverage": 0, "accuracy": 0, "consistency": 0, "feasibility": 0, "clarity": 0 } },
  "comments": { "A": { "strengths": ["..."], "weaknesses": ["..."] } },
  "recommendedLabel": "A または merged",
  "recommendation": "利用者向けに、どれを選ぶとよいかを2〜3文で",
  "merged": ${CANDIDATE_SHAPE.replace(/\n/g, "\n  ")}
}`;

export function buildEvaluatorPrompt(
  ctx: PromptContext,
  labeled: Array<{ label: string; content: CandidateContent }>,
): string {
  const blocks = labeled
    .map(
      (c) =>
        `### 案${c.label}\n` +
        c.content.items.map((i) => `- [${i.type}/${i.priority}] ${i.title}${i.description ? `：${i.description}` : ""}`).join("\n"),
    )
    .join("\n\n");
  return `${buildGeneratorPrompt(ctx)}

# 評価対象の案（提示順はランダム）
${blocks}

全ての案（${labeled.map((c) => c.label).join(", ")}）を評価してください。`;
}
