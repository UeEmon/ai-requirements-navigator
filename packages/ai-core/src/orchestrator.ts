import { extractJson } from "./json.js";
import { buildEvaluatorPrompt, buildGeneratorPrompt, EVALUATOR_SYSTEM, GENERATOR_SYSTEM, type PromptContext } from "./prompts.js";
import { CandidateContent, EvaluationContent, type Criterion, type CriterionScores } from "./schema.js";
import type { AIProvider, Usage } from "./types.js";

export type Weights = Record<Criterion, number>;

export const DEFAULT_WEIGHTS: Weights = {
  coverage: 0.25,
  accuracy: 0.25,
  consistency: 0.2,
  feasibility: 0.15,
  clarity: 0.15,
};

/** 進み具合の通知（非同期実行で画面に表示する） */
export type ProgressEvent = {
  type: "generator" | "evaluator";
  providerId: string;
  status: "running" | "done" | "failed";
  reason?: string;
};

export interface RoundOptions {
  generators: AIProvider[];
  /** 複数AIモードで使う評価AI。単一AIモードでは省略 */
  evaluator?: AIProvider;
  /** 機密プロジェクト: 社外に送信するAIを使わない */
  confidential?: boolean;
  timeoutMs?: number;
  weights?: Weights;
  /** 匿名化の並び順に使う乱数（テストで固定する） */
  random?: () => number;
  onProgress?: (e: ProgressEvent) => void;
}

export interface LabeledCandidate {
  label: string;
  /** 決定前は画面に出さない。API層で伏せる */
  providerId: string;
  content: CandidateContent;
  usage: Usage;
  latencyMs: number;
}

export interface Failure {
  providerId: string;
  reason: string;
}

export interface ScoredEvaluation extends EvaluationContent {
  evaluatorId: string;
  totals: Record<string, number>;
  mergedTotal: number;
  usage: Usage;
}

export interface RoundResult {
  candidates: LabeledCandidate[];
  failures: Failure[];
  evaluation?: ScoredEvaluation;
  warnings: string[];
}

export class RoundError extends Error {
  constructor(
    message: string,
    readonly code: "no_generator" | "confidential" | "all_failed",
    readonly failures: Failure[] = [],
  ) {
    super(message);
    this.name = "RoundError";
  }
}

const LABELS = ["A", "B", "C", "D", "E", "F"];

export function weightedTotal(s: CriterionScores, w: Weights = DEFAULT_WEIGHTS): number {
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return Math.round(
    (Object.keys(w) as Criterion[]).reduce((acc, k) => acc + s[k] * w[k], 0) / sum,
  );
}

function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fn(ctrl.signal).finally(() => clearTimeout(timer));
}

function shuffle<T>(arr: T[], random: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 1ラウンドの処理: 並列生成 → 検証 → 匿名化 → 評価 → 合計点の算出。
 * 合計点はAIの申告ではなく、ここで重みから計算する（評価AIの計算ミスを防ぐ）。
 */
export async function runRound(ctx: PromptContext, opts: RoundOptions): Promise<RoundResult> {
  const { generators, evaluator } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const random = opts.random ?? Math.random;
  const warnings: string[] = [];

  if (!generators.length) throw new RoundError("生成AIを1つ以上選んでください", "no_generator");
  if (opts.confidential) {
    const external = [...generators, ...(evaluator ? [evaluator] : [])].filter((p) => !p.isLocal);
    if (external.length) {
      throw new RoundError(
        `機密プロジェクトでは社外に送信するAIは使えません: ${external.map((p) => p.label).join(", ")}`,
        "confidential",
      );
    }
  }
  if (evaluator && generators.some((g) => g.id === evaluator.id)) {
    warnings.push("評価AIが生成AIにも含まれています。自分の案を高く評価する偏りが出る可能性があります。");
  }

  const emit = (e: ProgressEvent) => {
    try {
      opts.onProgress?.(e);
    } catch {
      /* 通知の失敗で処理を止めない */
    }
  };
  const userPrompt = buildGeneratorPrompt(ctx);
  const settled = await Promise.all(
    generators.map(async (p) => {
      emit({ type: "generator", providerId: p.id, status: "running" });
      try {
        const res = await withTimeout(timeoutMs, (signal) =>
          p.complete({ system: GENERATOR_SYSTEM, messages: [{ role: "user", content: userPrompt }], json: true, signal }),
        );
        const content = CandidateContent.parse(extractJson(res.text));
        emit({ type: "generator", providerId: p.id, status: "done" });
        return { ok: true as const, providerId: p.id, content, usage: res.usage, latencyMs: res.latencyMs };
      } catch (e) {
        emit({ type: "generator", providerId: p.id, status: "failed", reason: (e as Error).message });
        return { ok: false as const, providerId: p.id, reason: (e as Error).message };
      }
    }),
  );

  const failures: Failure[] = settled.filter((s) => !s.ok).map((s) => ({ providerId: s.providerId, reason: (s as any).reason }));
  const okOnes = settled.filter((s) => s.ok);
  if (!okOnes.length) throw new RoundError("すべてのAIで案の生成に失敗しました", "all_failed", failures);
  if (failures.length) warnings.push(`${failures.length}件のAIで生成に失敗しました。取得できた案で続行します。`);

  const candidates: LabeledCandidate[] = shuffle(okOnes, random).map((s, i) => ({
    label: LABELS[i]!,
    providerId: s.providerId,
    content: s.content,
    usage: s.usage,
    latencyMs: s.latencyMs,
  }));

  let evaluation: ScoredEvaluation | undefined;
  if (evaluator && candidates.length >= 1) {
    emit({ type: "evaluator", providerId: evaluator.id, status: "running" });
    try {
      const prompt = buildEvaluatorPrompt(ctx, candidates.map((c) => ({ label: c.label, content: c.content })));
      const res = await withTimeout(timeoutMs, (signal) =>
        evaluator.complete({ system: EVALUATOR_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, signal }),
      );
      const ev = EvaluationContent.parse(extractJson(res.text));
      const totals: Record<string, number> = {};
      for (const c of candidates) {
        const s = ev.scores[c.label];
        if (s) totals[c.label] = weightedTotal(s, weights);
        else warnings.push(`評価AIが案${c.label}を採点しませんでした。`);
      }
      const mergedScores: CriterionScores = {
        coverage: Math.max(...Object.values(ev.scores).map((s) => s.coverage)),
        accuracy: Math.max(...Object.values(ev.scores).map((s) => s.accuracy)),
        consistency: Math.max(...Object.values(ev.scores).map((s) => s.consistency)),
        feasibility: Math.max(...Object.values(ev.scores).map((s) => s.feasibility)),
        clarity: Math.max(...Object.values(ev.scores).map((s) => s.clarity)),
      };
      evaluation = {
        ...ev,
        evaluatorId: evaluator.id,
        totals,
        // 統合案は各基準の最高点を上限とする参考値
        mergedTotal: weightedTotal(mergedScores, weights),
        usage: res.usage,
      };
      emit({ type: "evaluator", providerId: evaluator.id, status: "done" });
    } catch (e) {
      emit({ type: "evaluator", providerId: evaluator.id, status: "failed", reason: (e as Error).message });
      warnings.push(`評価に失敗しました（${(e as Error).message}）。案は比較せずに表示します。`);
    }
  }

  return { candidates, failures, evaluation, warnings };
}
