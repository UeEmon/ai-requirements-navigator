/**
 * 非機能要件の適正化（過大にしない）のための事例比較（機能 F5-9）。
 *
 * 非機能要件は「念のため」で高くなりがちで、費用と期間を押し上げる。
 * システムの規模・目的・予算が似た事例と並べて、項目ごとに「似たシステムはどの水準にしているか」を示し、
 * 事例より高い水準を選ぶときは理由を求める。
 *
 * 事例は2種類:
 * - 参考類型: 本システムに組み込んだ、よくあるシステムの類型ごとの一般的な水準の目安。
 *   特定の実在システムのデータではない（利用者にもそう表示する）
 * - 組織の過去事例: 同じ組織の他のプロジェクトで決めた非機能要件シート
 */
import { z } from "zod";
import { extractJson } from "./json.js";
import { NFR_ITEM_BY_KEY, NFR_ITEMS, PROFILE_QUESTIONS, type NfrDecision, type NfrFinding, type NfrProfile, type ProfileKey } from "./nfr.js";
import type { AIProvider, Usage } from "./types.js";

export interface NfrCase {
  id: string;
  name: string;
  /** builtin: 参考類型 / org: 組織の過去事例 */
  source: "builtin" | "org";
  description: string;
  profile: NfrProfile;
  /** 項目キー → 水準（L1〜） */
  levels: Record<string, string>;
}

/** 項目の並び（参考類型の水準を1文字ずつ書くため） */
const ORDER = NFR_ITEMS.map((i) => i.key);
const levelsOf = (digits: string): Record<string, string> => {
  const ds = digits.replace(/\s+/g, "");
  if (ds.length !== ORDER.length) throw new Error(`参考類型の水準の数が合いません: ${ds.length}`);
  return Object.fromEntries(ORDER.map((k, i) => [k, `L${ds[i]}`]));
};
const P = (users: 0 | 1 | 2, impact: 0 | 1 | 2, data: 0 | 1 | 2, hours: 0 | 1 | 2, scale: 0 | 1 | 2, purpose: 0 | 1 | 2, budget: 0 | 1 | 2): NfrProfile => ({ users, impact, data, hours, scale, purpose, budget });

/*
 * 項目の順: 運用時間 稼働率 RTO RPO 災害 | 利用者数 応答 集中 増加 締め | バックアップ 監視 計画停止 問合せ |
 *           移行データ 切替 | 認証 権限 暗号化 記録 脆弱性 | 端末 法令 設置場所 | アクセシビリティ 習熟
 */
export const BUILTIN_CASES: NfrCase[] = (
  [
  {
    id: "b-small-booking",
    name: "小規模店舗の予約受付",
    description: "美容室・整体院などのWeb予約。スタッフ数名、顧客数百人。止まっても電話で受け付けられる。",
    profile: P(2, 0, 2, 2, 0, 1, 0),
    levels: levelsOf("32111 12111 2221 21 12322 221 23"),
  },
  {
    id: "b-workflow",
    name: "社内の申請・承認（ワークフロー）",
    description: "従業員300人規模の経費・休暇申請。業務時間に使い、止まっても紙で代替できる。",
    profile: P(1, 0, 1, 0, 1, 0, 0),
    levels: levelsOf("12211 22221 2221 21 23222 112 12"),
  },
  {
    id: "b-sales",
    name: "中堅企業の販売・在庫管理（基幹）",
    description: "従業員500人規模。受注から出荷まで。止まると出荷が止まる。",
    profile: P(1, 1, 1, 1, 1, 2, 1),
    levels: levelsOf("23222 22222 2221 22 23222 122 11"),
  },
  {
    id: "b-ec",
    name: "中規模のECサイト",
    description: "会員数万人。24時間受注し、セール時に利用が集中する。決済と個人情報を扱う。",
    profile: P(2, 2, 2, 2, 2, 2, 1),
    levels: levelsOf("33332 32322 3322 21 22323 321 23"),
  },
  {
    id: "b-gov",
    name: "自治体の住民向けオンライン申請",
    description: "住民数万〜数十万人。個人情報を扱い、だれもが使えることが求められる。",
    profile: P(2, 1, 2, 2, 2, 1, 1),
    levels: levelsOf("33222 22222 2221 11 23333 332 33"),
  },
  {
    id: "b-clinic",
    name: "診療所の予約・問診",
    description: "患者向けのWeb予約と事前問診。医療情報を扱う。患者は数千人規模。",
    profile: P(2, 1, 2, 2, 1, 1, 0),
    levels: levelsOf("32222 12211 2221 21 22322 232 23"),
  },
  {
    id: "b-portal",
    name: "社内ポータル・お知らせ掲示板",
    description: "社内のお知らせと資料の共有。止まってもメールで代替できる。",
    profile: P(1, 0, 1, 0, 1, 0, 0),
    levels: levelsOf("11111 22111 1111 11 12211 211 13"),
  },
  {
    id: "b-warehouse",
    name: "物流倉庫の入出荷管理",
    description: "24時間稼働の物流拠点。止まると出荷が止まり、取引先に影響する。",
    profile: P(1, 2, 1, 2, 1, 2, 1),
    levels: levelsOf("33322 23222 2323 23 12222 112 11"),
  },
  {
    id: "b-school",
    name: "会員制スクールの受講・会費管理",
    description: "会員千人規模。受講予約と会費の管理。止まってもその日のうちに戻ればよい。",
    profile: P(2, 0, 2, 1, 1, 1, 0),
    levels: levelsOf("22111 22212 2221 21 12322 221 23"),
  },
  {
    id: "b-hr",
    name: "人事・給与",
    description: "従業員千人規模。個人情報と給与情報を扱う。毎月の締め処理がある。",
    profile: P(1, 1, 2, 0, 1, 2, 1),
    levels: levelsOf("12222 22212 2221 32 33332 122 11"),
  },
  {
    id: "b-dept-tool",
    name: "部署内の集計・管理ツール",
    description: "Excelの置き換え。数十人が業務時間に使う。",
    profile: P(0, 0, 1, 0, 0, 0, 0),
    levels: levelsOf("11111 11111 1111 21 11211 111 11"),
  },
  {
    id: "b-finance",
    name: "金融機関のオンラインサービス（参考：最上位）",
    description: "社会的影響が極めて大きいシステムの例。多くのシステムではここまでは不要。",
    profile: P(2, 2, 2, 2, 2, 2, 2),
    levels: levelsOf("34433 33333 3333 33 33333 333 33"),
  },
  ] as Array<Omit<NfrCase, "source">>
).map((c) => ({ ...c, source: "builtin" as const }));

/** 2つのシステムの性格がどのくらい似ているか（0〜1）。両方が答えた質問だけで比べる */
export function similarity(a: NfrProfile, b: NfrProfile): number {
  const W: Record<ProfileKey, number> = { impact: 2, scale: 1.5, budget: 1.5, purpose: 1, users: 1, data: 1, hours: 1 };
  let sum = 0;
  let total = 0;
  for (const k of Object.keys(PROFILE_QUESTIONS) as ProfileKey[]) {
    if (a[k] === undefined || b[k] === undefined) continue;
    total += W[k];
    sum += W[k] * (1 - Math.abs(a[k]! - b[k]!) / 2);
  }
  return total ? sum / total : 0;
}

export function caseCost(c: Pick<NfrCase, "levels">): number {
  return NFR_ITEMS.reduce((a, i) => a + (i.levels.find((l) => l.id === c.levels[i.key])?.cost ?? 1), 0);
}

export interface SizingReview {
  /** 比較できるほどシステムの性格が答えられているか */
  ready: boolean;
  similar: Array<NfrCase & { similarity: number; cost: number }>;
  /** 項目ごとの、似た事例の水準 */
  perItem: Record<string, { levels: Array<{ caseId: string; name: string; level: string }>; max: string | null; typical: string | null }>;
  findings: NfrFinding[];
  /** 似た事例の費用・手間の目安の平均 */
  typicalCost: number | null;
}

/**
 * 似た事例と比べて、過大な水準を指摘する。
 * - 似た事例のどれよりも高い水準（理由がなければ指摘）
 * - 全体の費用・手間の目安が、似た事例の平均を大きく上回る
 */
export function reviewSizing(profile: NfrProfile, decisions: Record<string, NfrDecision>, cases: NfrCase[], opts: { top?: number; chosenCost?: number } = {}): SizingReview {
  const answered = Object.values(profile).filter((v) => v !== undefined).length;
  const ready = answered >= 3;
  const similar = ready
    ? cases
        .map((c) => ({ ...c, similarity: similarity(profile, c.profile), cost: caseCost(c) }))
        .filter((c) => c.similarity >= 0.6)
        .sort((a, b) => b.similarity - a.similarity || a.cost - b.cost)
        .slice(0, opts.top ?? 3)
    : [];
  const perItem: SizingReview["perItem"] = {};
  const findings: NfrFinding[] = [];
  for (const item of NFR_ITEMS) {
    const levels = similar.filter((c) => c.levels[item.key]).map((c) => ({ caseId: c.id, name: c.name, level: c.levels[item.key]! }));
    const idx = (id: string) => item.levels.findIndex((l) => l.id === id);
    const sorted = [...levels].sort((a, b) => idx(a.level) - idx(b.level));
    const max = sorted.at(-1)?.level ?? null;
    const typical = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]!.level : null;
    perItem[item.key] = { levels, max, typical };
    const d = decisions[item.key];
    if (d?.status !== "decided" || !d.level || !max || levels.length < 2) continue;
    if (idx(d.level) > idx(max) && !d.rationale.trim()) {
      const lv = (id: string) => NFR_ITEM_BY_KEY.get(item.key)!.levels.find((l) => l.id === id)?.label ?? id;
      findings.push({
        severity: "warning",
        items: [item.key],
        message: `「${item.name}」が、似た事例（${levels.map((l) => l.name).join("・")}）のどれよりも高い水準です（事例は最大でも「${lv(max)}」）。過大でないか確認し、必要なら理由を記録してください。`,
      });
    }
  }
  const typicalCost = similar.length ? Math.round(similar.reduce((a, c) => a + c.cost, 0) / similar.length) : null;
  if (typicalCost !== null && opts.chosenCost !== undefined && opts.chosenCost > typicalCost * 1.2) {
    findings.push({
      severity: "warning",
      items: [],
      message: `非機能要件全体の費用・手間の目安（${opts.chosenCost}）が、似た事例の平均（${typicalCost}）を大きく上回っています。過大な項目がないか見直してください。`,
    });
  }
  return { ready, similar, perItem, findings, typicalCost };
}

/** 組織の他のプロジェクトの非機能要件シートを事例にする（6割以上決まっているものだけ） */
export function orgCaseFrom(projectId: string, projectName: string, purpose: string, profile: NfrProfile, decisions: Record<string, NfrDecision>): NfrCase | null {
  const levels: Record<string, string> = {};
  for (const item of NFR_ITEMS) {
    const d = decisions[item.key];
    if (d?.status === "decided" && d.level) levels[item.key] = d.level;
  }
  if (Object.keys(levels).length < NFR_ITEMS.length * 0.6) return null;
  return { id: `org-${projectId}`, name: `社内事例：${projectName}`, source: "org", description: purpose || "同じ組織の過去のプロジェクト", profile, levels };
}

/* ------------------------------------------------------------------ */
/* AIによる適正化の見直し                                                 */
/* ------------------------------------------------------------------ */

export const NFR_SIZING_SYSTEM = `あなたはシステムの費用対効果を見極める、非機能要件の費用対効果の専門家です。決めた非機能要件の水準のうち、システムの規模・目的・予算や似た事例に比べて過大なものを見つけ、適正な水準を提案します。
- 業務上の理由が書かれていて、その理由が妥当なものは指摘しない
- 「念のため」「将来のため」だけの高い水準は、今の業務に見合う水準に下げる提案をする
- 下げると業務やリスクにどんな影響があるかも書く
- 過大なものがなければ items は空にする
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{ "items": [{ "key": "av.rate", "level": "L2", "reason": "過大と考える理由", "risk": "下げた場合の影響" }] }`;

const SizingContent = z.object({
  items: z.array(z.object({ key: z.string(), level: z.string(), reason: z.string().max(500).default(""), risk: z.string().max(500).default("") })).max(40),
});

export function buildSizingPrompt(input: { projectName: string; purpose: string; profile: NfrProfile; decisions: Record<string, NfrDecision>; similar: NfrCase[] }): string {
  const prof = (Object.keys(PROFILE_QUESTIONS) as ProfileKey[])
    .filter((k) => input.profile[k] !== undefined)
    .map((k) => `- ${PROFILE_QUESTIONS[k].question} ${PROFILE_QUESTIONS[k].options[input.profile[k]!]}`)
    .join("\n");
  const rows = NFR_ITEMS.filter((i) => input.decisions[i.key]?.status === "decided" && input.decisions[i.key]!.level)
    .map((i) => {
      const d = input.decisions[i.key]!;
      const lv = i.levels.find((l) => l.id === d.level);
      return `## ${i.key} ${i.name}\n決めた水準: ${d.level} ${lv?.label ?? ""}\n選択肢: ${i.levels.map((l) => `${l.id}=${l.label}`).join(" / ")}\n理由: ${d.rationale || "（なし）"}\n似た事例: ${input.similar.map((c) => `${c.name}=${c.levels[i.key] ?? "?"}`).join(" / ") || "（なし）"}`;
    })
    .join("\n\n");
  return `# プロジェクト\n名称: ${input.projectName}\n目的: ${input.purpose || "（未記入）"}\n\n# システムの性格\n${prof || "（未回答）"}\n\n# 決めた非機能要件\n${rows || "（まだありません）"}`;
}

export interface SizingSuggestion {
  key: string;
  /** 下げる先の水準（多数のAIが選んだもの） */
  level: string;
  votes: number;
  analysts: number;
  reasons: Array<{ providerId: string; level: string; reason: string; risk: string }>;
}

/** 使えるAIすべてで過大な水準を探し、何台が同じ指摘をしたかをまとめる */
export async function reviewSizingWithAi(
  providers: AIProvider[],
  input: Parameters<typeof buildSizingPrompt>[0],
  opts: { timeoutMs?: number; onProgress?: (providerId: string, status: "running" | "done" | "failed", reason?: string) => void } = {},
): Promise<{ items: SizingSuggestion[]; usages: Array<{ providerId: string; usage: Usage }>; failures: Array<{ providerId: string; reason: string }>; analysts: number }> {
  const prompt = buildSizingPrompt(input);
  const results = await Promise.all(
    providers.map(async (p) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
      opts.onProgress?.(p.id, "running");
      try {
        const res = await p.complete({ system: NFR_SIZING_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, maxTokens: 4000, signal: ctrl.signal });
        const c = SizingContent.parse(extractJson(res.text));
        opts.onProgress?.(p.id, "done");
        return { ok: true as const, providerId: p.id, items: c.items, usage: res.usage };
      } catch (e) {
        const reason = ctrl.signal.aborted ? "時間内に応答がありませんでした" : (e as Error).message;
        opts.onProgress?.(p.id, "failed", reason);
        return { ok: false as const, providerId: p.id, reason };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const ok = results.filter((r): r is Extract<(typeof results)[number], { ok: true }> => r.ok);
  const failures = results.filter((r) => !r.ok).map((r) => ({ providerId: r.providerId, reason: (r as { reason: string }).reason }));
  if (!ok.length) {
    const err = new Error("非機能要件の見直しができませんでした") as Error & { failures: typeof failures };
    err.failures = failures;
    throw err;
  }
  const items: SizingSuggestion[] = [];
  for (const item of NFR_ITEMS) {
    const d = input.decisions[item.key];
    const cur = item.levels.findIndex((l) => l.id === d?.level);
    if (cur < 0) continue;
    // 今より低い、実在する水準の提案だけを数える
    const reasons = ok.flatMap((r) =>
      r.items
        .filter((x) => x.key === item.key)
        .filter((x) => {
          const j = item.levels.findIndex((l) => l.id === x.level);
          return j >= 0 && j < cur;
        })
        .slice(0, 1)
        .map((x) => ({ providerId: r.providerId, level: x.level, reason: x.reason, risk: x.risk })),
    );
    if (!reasons.length) continue;
    const votes = new Map<string, number>();
    for (const r of reasons) votes.set(r.level, (votes.get(r.level) ?? 0) + 1);
    // 同数なら、下げ幅の小さい（高い）方を提案する
    const level = [...votes].sort((a, b) => b[1] - a[1] || item.levels.findIndex((l) => l.id === b[0]) - item.levels.findIndex((l) => l.id === a[0]))[0]![0];
    items.push({ key: item.key, level, votes: reasons.length, analysts: ok.length, reasons });
  }
  return { items, usages: ok.map((r) => ({ providerId: r.providerId, usage: r.usage })), failures, analysts: ok.length };
}
