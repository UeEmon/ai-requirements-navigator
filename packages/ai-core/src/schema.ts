import { z } from "zod";
import { Ears, EARS_TYPES, renderEars } from "./ears.js";

export const RequirementType = z.enum(["BR", "AC", "FR", "NFR", "CN"]);
export type RequirementType = z.infer<typeof RequirementType>;

export const RequirementItem = z
  .object({
    title: z.string().default(""),
    description: z.string().default(""),
    type: RequirementType,
    priority: z.enum(["must", "should", "could"]).default("should"),
    /** 機能要件・非機能要件の EARS 記法の構造。あれば title はここから組み立てる */
    ears: Ears.optional(),
  })
  .transform((it) => withEars(it))
  .refine((it) => it.title.trim().length > 0, { message: "要件の文がありません" });
export type RequirementItem = z.infer<typeof RequirementItem>;

/** 機能要件・非機能要件は EARS の構造から文を組み立てる。対象外の区分では構造を捨てる */
export function withEars<T extends { title: string; type: string; ears?: Ears }>(it: T): T {
  if (!EARS_TYPES.includes(it.type)) {
    const { ears: _drop, ...rest } = it;
    return rest as T;
  }
  if (it.ears) return { ...it, title: renderEars(it.ears) };
  return it;
}

/** 生成AIが返す1案 */
export const CandidateContent = z.object({
  items: z.array(RequirementItem).min(1),
  /** 利用者に追加で確認したいこと */
  questions: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type CandidateContent = z.infer<typeof CandidateContent>;

const score = z.number().min(0).max(100);
export const CriterionScores = z.object({
  coverage: score,
  accuracy: score,
  consistency: score,
  feasibility: score,
  clarity: score,
});
export type CriterionScores = z.infer<typeof CriterionScores>;
export type Criterion = keyof CriterionScores;

/** 評価AIが返す結果。キーは匿名ラベル（A, B, C, D） */
export const EvaluationContent = z.object({
  scores: z.record(z.string(), CriterionScores),
  comments: z
    .record(
      z.string(),
      z.object({
        strengths: z.array(z.string()).default([]),
        weaknesses: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  recommendedLabel: z.string(),
  recommendation: z.string(),
  merged: CandidateContent,
});
export type EvaluationContent = z.infer<typeof EvaluationContent>;
