import { z } from "zod";

export const RequirementType = z.enum(["BR", "AC", "FR", "NFR", "CN"]);
export type RequirementType = z.infer<typeof RequirementType>;

export const RequirementItem = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  type: RequirementType,
  priority: z.enum(["must", "should", "could"]).default("should"),
});
export type RequirementItem = z.infer<typeof RequirementItem>;

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
