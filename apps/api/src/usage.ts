import type { ProviderCredential, Store, UsageRow } from "./store.js";

/**
 * 月間トークン上限の判定。
 * 月の区切りは USAGE_TIMEZONE（既定: Asia/Tokyo）の暦で数える。
 * 上限は「呼び出し前の時点で上限に達していたら止める」方式のため、
 * 1回の呼び出しぶん上限を少し超えることがある。
 */

export const WARN_RATIO = 0.8;

function partsIn(date: Date, tz: string): Record<string, string> {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
}

/** その時刻における、指定タイムゾーンのUTCからのずれ（ミリ秒） */
function offsetMs(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 指定タイムゾーンで見た「今月1日 0:00」の時刻 */
export function monthStart(now: Date, tz: string): Date {
  const p = partsIn(now, tz);
  const guess = Date.UTC(+p.year!, +p.month! - 1, 1);
  return new Date(guess - offsetMs(new Date(guess), tz));
}

export function monthLabel(now: Date, tz: string): string {
  const p = partsIn(now, tz);
  return `${p.year}-${p.month}`;
}

export interface UsageReport {
  month: string;
  since: string;
  timezone: string;
  org: { limit: number | null; used: number };
  providers: Array<UsageRow & { label: string; limit: number | null; used: number; deleted: boolean }>;
}

export async function usageReport(
  store: Store,
  orgId: string,
  orgLimit: number | null,
  creds: ProviderCredential[],
  tz: string,
  now = new Date(),
): Promise<UsageReport> {
  const since = monthStart(now, tz);
  const rows = await store.usageSummary(orgId, since);
  const byId = new Map(rows.map((r) => [r.providerId, r]));
  const providers: UsageReport["providers"] = creds.map((c) => {
    const r = byId.get(c.id) ?? { providerId: c.id, inputTokens: 0, outputTokens: 0, calls: 0 };
    return { ...r, label: c.label, limit: c.monthlyTokenLimit, used: r.inputTokens + r.outputTokens, deleted: false };
  });
  // 削除済みのAIの利用量も合計に含める
  for (const r of rows) {
    if (!creds.some((c) => c.id === r.providerId)) {
      providers.push({ ...r, label: "（削除済みのAI）", limit: null, used: r.inputTokens + r.outputTokens, deleted: true });
    }
  }
  return {
    month: monthLabel(now, tz),
    since: since.toISOString(),
    timezone: tz,
    org: { limit: orgLimit, used: rows.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0) },
    providers,
  };
}

export interface BudgetCheck {
  /** 組織の上限に達している場合の理由（呼び出し不可） */
  blocked: string | null;
  /** 上限に達したため使えないAIのID */
  excluded: Set<string>;
  warnings: string[];
}

const pct = (used: number, limit: number) => Math.floor((used / limit) * 100);
const fmt = (n: number) => n.toLocaleString("ja-JP");

export function checkBudget(report: UsageReport, ids: string[]): BudgetCheck {
  const warnings: string[] = [];
  const excluded = new Set<string>();
  const { limit, used } = report.org;
  if (limit !== null && used >= limit) {
    return {
      blocked: `今月（${report.month}）の組織のトークン上限 ${fmt(limit)} に達しました（利用 ${fmt(used)}）。管理者が上限を見直すか、来月までお待ちください`,
      excluded,
      warnings,
    };
  }
  if (limit !== null && used >= limit * WARN_RATIO) {
    warnings.push(`組織の今月の利用量が上限の ${pct(used, limit)}% に達しています（${fmt(used)} / ${fmt(limit)}）。`);
  }
  for (const id of ids) {
    const p = report.providers.find((x) => x.providerId === id);
    if (!p || p.limit === null) continue;
    if (p.used >= p.limit) {
      excluded.add(id);
      warnings.push(`「${p.label}」は今月の上限 ${fmt(p.limit)} に達したため使いませんでした。`);
    } else if (p.used >= p.limit * WARN_RATIO) {
      warnings.push(`「${p.label}」の今月の利用量が上限の ${pct(p.used, p.limit)}% に達しています。`);
    }
  }
  return { blocked: null, excluded, warnings };
}
