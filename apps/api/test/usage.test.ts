import { describe, expect, it } from "vitest";
import { checkBudget, monthLabel, monthStart, type UsageReport } from "../src/usage.js";

describe("月の区切り", () => {
  it("日本時間の1日0時を月初とする", () => {
    // 10/1 0:30 JST = 9/30 15:30 UTC → 10月
    const t = new Date("2026-09-30T15:30:00Z");
    expect(monthLabel(t, "Asia/Tokyo")).toBe("2026-10");
    expect(monthStart(t, "Asia/Tokyo").toISOString()).toBe("2026-09-30T15:00:00.000Z");
    // 9/30 23:30 JST はまだ9月
    expect(monthLabel(new Date("2026-09-30T14:30:00Z"), "Asia/Tokyo")).toBe("2026-09");
  });

  it("UTCや夏時間のある地域でも月初を返す", () => {
    expect(monthStart(new Date("2026-10-15T00:00:00Z"), "UTC").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // 2026-07-01 0:00 EDT = 04:00 UTC
    expect(monthStart(new Date("2026-07-10T12:00:00Z"), "America/New_York").toISOString()).toBe("2026-07-01T04:00:00.000Z");
  });
});

const report = (orgLimit: number | null, orgUsed: number, providers: Array<[string, number | null, number]>): UsageReport => ({
  month: "2026-10",
  since: "2026-09-30T15:00:00.000Z",
  timezone: "Asia/Tokyo",
  org: { limit: orgLimit, used: orgUsed },
  providers: providers.map(([id, limit, used]) => ({
    providerId: id,
    label: id,
    limit,
    used,
    inputTokens: used,
    outputTokens: 0,
    calls: 1,
    deleted: false,
  })),
});

describe("上限の判定", () => {
  it("組織の上限に達したら止める", () => {
    expect(checkBudget(report(1000, 1000, []), []).blocked).toContain("上限 1,000");
  });

  it("80%以上で警告する", () => {
    const b = checkBudget(report(1000, 850, [["a", 100, 90]]), ["a"]);
    expect(b.blocked).toBeNull();
    expect(b.warnings).toHaveLength(2);
    expect(b.excluded.size).toBe(0);
  });

  it("AI個別の上限に達したAIだけを外す", () => {
    const b = checkBudget(report(null, 0, [["a", 100, 100], ["b", 100, 10], ["c", null, 9999]]), ["a", "b", "c"]);
    expect([...b.excluded]).toEqual(["a"]);
  });
});
