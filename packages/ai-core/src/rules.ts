/**
 * 業務ルール（要件の区分 RL、機能 F11-1）。
 *
 * 計算のしかた・判定の条件・守るべき制約・状態が変わる条件など、機能要件の文だけでは決まらない
 * 「業務の決まり」を、文と具体例（この条件なら、こうなる）で残す。具体例はそのままテストケースになる。
 */
import { z } from "zod";
import { detectAmbiguity } from "./ambiguity.js";

export const RULE_KINDS = {
  calc: "計算",
  judge: "判定",
  constraint: "制約",
  transition: "状態が変わる条件",
} as const;
export type RuleKind = keyof typeof RULE_KINDS;

const text = z.string().max(300);
export const BusinessRule = z.object({
  kind: z.preprocess((v) => (typeof v === "string" && v in RULE_KINDS ? v : "judge"), z.enum(Object.keys(RULE_KINDS) as [RuleKind, ...RuleKind[]])),
  /** 具体例：条件（入力・状態）と、そのときの結果 */
  examples: z
    .array(z.object({ given: text.min(1), expected: text.min(1) }))
    .max(10)
    .default([]),
  /** 関係するエンティティ（設計モデルの名前、または業務の言葉） */
  entities: z.array(z.string().max(80)).max(10).default([]),
});
export type BusinessRule = z.infer<typeof BusinessRule>;

export const RULE_INSTRUCTIONS = `- 業務ルール（RL）は、計算のしかた・判定の条件・守るべき制約・状態が変わる条件を title に1文で書き、"rule" に構造を入れる
  - kind: calc（計算）/ judge（判定）/ constraint（制約）/ transition（状態が変わる条件）
  - examples: 具体例を2つ以上。given に条件（入力値・状態）、expected にそのときの結果を、数値や値で書く（境界の値を含める）
  - entities: 関係するデータ（例「予約」「料金」）`;

export const RULE_SHAPE = `"rule": { "kind": "calc", "examples": [{ "given": "...", "expected": "..." }], "entities": ["..."] }`;

export interface RuleIssue {
  kind: "examples" | "ambiguous";
  message: string;
}

/** 業務ルールの検査：具体例が2つ以上あるか、解釈が分かれる言葉がないか */
export function lintRule(title: string, rule: BusinessRule | null | undefined): { ok: boolean; issues: RuleIssue[] } {
  const issues: RuleIssue[] = [];
  const n = rule?.examples.length ?? 0;
  if (n < 2) issues.push({ kind: "examples", message: n ? "具体例が1つだけです。境界の値を含めて2つ以上にしてください" : "具体例（この条件なら、こうなる）がありません" });
  const seen = new Set<string>();
  for (const h of detectAmbiguity([title, ...(rule?.examples ?? []).flatMap((e) => [e.given, e.expected])].join("\n"))) {
    if (seen.has(h.term)) continue;
    seen.add(h.term);
    issues.push({ kind: "ambiguous", message: `「${h.term}」は解釈が分かれます。${h.ask}` });
  }
  return { ok: issues.length === 0, issues };
}
