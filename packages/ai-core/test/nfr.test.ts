import { describe, expect, it } from "vitest";
import {
  evaluateNfr,
  gradesOf,
  lintEars,
  MockProvider,
  NFR_ITEM_BY_KEY,
  NFR_ITEMS,
  nfrRequirement,
  nfrSheetLines,
  recommendedLevel,
  suggestNfr,
  type NfrDecision,
} from "../src/index.js";

const dec = (level: string | null, extra: Partial<NfrDecision> = {}): NfrDecision => ({ status: "decided", level, value: "", rationale: "", owner: "", ...extra });
const item = (k: string) => NFR_ITEM_BY_KEY.get(k)!;

describe("非機能要件", () => {
  it("26項目すべてに質問・理由・水準・推奨があり、決めた水準はすべて EARS の検査を通る", () => {
    expect(NFR_ITEMS).toHaveLength(26);
    expect(new Set(NFR_ITEMS.map((i) => i.key)).size).toBe(26);
    for (const i of NFR_ITEMS) {
      expect(i.question && i.why).toBeTruthy();
      for (const r of i.recommended) expect(i.levels[r]).toBeTruthy();
      for (const lv of i.levels) {
        const r = nfrRequirement(i, dec(lv.id), "予約システム");
        if (r) expect(lintEars(r.title, "NFR")).toMatchObject({ ok: true });
      }
    }
  });

  it("システムの性格から大項目ごとの重要度と推奨水準を決める", () => {
    const low = { users: 0, impact: 0, data: 0, hours: 0 } as const;
    const high = { users: 2, impact: 2, data: 2, hours: 2 } as const;
    expect(gradesOf(low).availability).toBe(0);
    expect(gradesOf({ impact: 0, hours: 2 }).availability).toBe(2);
    expect(gradesOf({}).overall).toBe(1); // 未回答は中
    expect(recommendedLevel(item("av.rate"), low).value).toBe("95%");
    expect(recommendedLevel(item("av.rate"), high).value).toBe("99.9%");
    expect(recommendedLevel(item("sc.auth"), { data: 2 }).id).toBe("L3");
  });

  it("決めた水準を EARS の非機能要件にする（作らない水準・体制の項目・自由入力）", () => {
    expect(nfrRequirement(item("pf.response"), dec("L2"), "予約システム")!.title).toBe("利用者が画面を操作したとき、予約システムは、操作の95%について3秒以内に結果を表示しなければならない。");
    expect(nfrRequirement(item("av.rto"), dec("L3"))!.title).toBe("障害でシステムが停止した場合、システムは、1時間以内に利用を再開できるようにしなければならない。");
    expect(nfrRequirement(item("pf.peak"), dec("L2"))!.title).toBe("利用が通常の3倍に集中している間、システムは、応答時間の目標を満たさなければならない。");
    expect(nfrRequirement(item("op.monitoring"), dec("L1"))).toBeNull();
    expect(nfrRequirement(item("op.support"), dec("L3"))).toBeNull();
    expect(nfrRequirement(item("av.rate"), dec(null, { value: "99.5%" }))!.title).toBe("システムは、運用時間中の稼働率99.5%以上を維持しなければならない。");
    expect(nfrRequirement(item("av.rate"), { ...dec("L2"), status: "na" })).toBeNull();
  });

  it("項目どうしの矛盾・推奨より低い水準・理由のない対象外・決める人のいない保留を検出する", () => {
    const profile = { users: 2, impact: 1, data: 2, hours: 2 } as const;
    const r = evaluateNfr(profile, {
      "av.rate": dec("L3"),
      "av.rto": dec("L1"),
      "op.monitoring": dec("L1"),
      "av.hours": dec("L3"),
      "op.maintenance": dec("L1"),
      "sc.data": dec("L2"),
      "sc.auth": dec("L1"),
      "us.access": { ...dec(null), status: "na" },
      "mg.cutover": { ...dec(null), status: "deferred" },
    });
    const msgs = r.findings.map((f) => `${f.severity}:${f.items.join("+")}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "error:av.rate+op.monitoring",
        "error:av.rate+av.rto",
        "warning:av.hours+op.maintenance",
        "error:sc.data",
        "warning:sc.auth",
        "error:sc.auth", // 推奨（L3）より2段低いのに理由がない
        "error:us.access", // 対象外の理由がない
        "warning:mg.cutover", // 保留で決める人がいない
      ]),
    );
    expect(r.counts).toEqual({ undecided: 17, decided: 7, na: 1, deferred: 1 });
    expect(r.coverage).toBeCloseTo(9 / 26);
    expect(r.byCategory.availability).toEqual({ total: 5, considered: 3 });
    // 理由を書けば「推奨より低い」は消える
    const ok = evaluateNfr(profile, { "sc.auth": dec("L1", { rationale: "社内の共通ログインを別途使うため" }) });
    expect(ok.findings.filter((f) => f.items.includes("sc.auth") && f.severity === "error")).toEqual([]);
  });

  it("複数AIに推奨水準を提案させ、意見が分かれた項目を示す", async () => {
    // seed の偶奇が異なる2つのID（模擬AIは片方だけ稼働率を1段上にする）
    const ids = ["a", "b", "c", "d", "e"];
    const odd = ids.find((x) => [...x].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2 === 1)!;
    const even = ids.find((x) => [...x].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2 === 0)!;
    const r = await suggestNfr([new MockProvider(even), new MockProvider(odd)], { projectName: "予約", purpose: "", profile: { impact: 1 }, requirements: [] });
    expect(r.suggestions).toHaveLength(26);
    const rate = r.suggestions.find((s) => s.key === "av.rate")!;
    expect(rate.split).toBe(true);
    expect(rate.consensus).toBe("L2"); // 同数なら低い方
    const resp = r.suggestions.find((s) => s.key === "pf.response")!;
    expect(resp).toMatchObject({ split: false, consensus: "L2" });
    expect(r.suggestions.find((s) => s.key === "pf.peak")!.proposals[0]!.question).toBe("月末に利用が増えますか？");
  });

  it("仕様書用に全項目の状態を1行ずつ返す", () => {
    const lines = nfrSheetLines({}, { "av.rate": dec("L2", { rationale: "業務時間内の利用のため" }) });
    expect(lines).toHaveLength(26);
    expect(lines[1]).toBe("［決定］可用性／稼働率（止まってよい時間）：99%（月に約7時間まで）（推奨：99%（月に約7時間まで）） 理由：業務時間内の利用のため");
    expect(lines[0]).toContain("［未検討］");
  });
});
