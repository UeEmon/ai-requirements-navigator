import { describe, expect, it } from "vitest";
import {
  BUILTIN_CASES,
  caseCost,
  evaluateNfr,
  MockProvider,
  NFR_ITEM_BY_KEY,
  NFR_ITEMS,
  recommendedLevel,
  orgCaseFrom,
  reviewSizing,
  reviewSizingWithAi,
  similarity,
  type NfrDecision,
} from "../src/index.js";

const dec = (level: string, rationale = ""): NfrDecision => ({ status: "decided", level, value: "", rationale, owner: "" });
const small = { users: 2, impact: 0, data: 2, hours: 2, scale: 0, purpose: 1, budget: 0 } as const;

describe("非機能要件の適正化（事例との比較）", () => {
  it("参考類型はすべての項目に実在する水準を持つ", () => {
    expect(BUILTIN_CASES.length).toBeGreaterThanOrEqual(10);
    for (const c of BUILTIN_CASES) {
      for (const i of NFR_ITEMS) expect(i.levels.some((l) => l.id === c.levels[i.key])).toBe(true);
    }
    // 最上位の例は、小規模の例より費用・手間が大きい
    expect(caseCost(BUILTIN_CASES.find((c) => c.id === "b-finance")!)).toBeGreaterThan(caseCost(BUILTIN_CASES.find((c) => c.id === "b-small-booking")!) + 20);
  });

  it("システムの性格が似た事例を探す（答えていない質問は比べない）", () => {
    expect(similarity(small, small)).toBe(1);
    expect(similarity({ impact: 0 }, { impact: 2 })).toBe(0);
    expect(similarity({}, small)).toBe(0);
    const r = reviewSizing(small, {}, BUILTIN_CASES);
    expect(r.ready).toBe(true);
    expect(r.similar[0]!.id).toBe("b-small-booking");
    expect(r.similar.map((c) => c.id)).not.toContain("b-finance");
    expect(r.perItem["av.rate"]!.levels.length).toBe(r.similar.length);
    expect(reviewSizing({ impact: 1 }, {}, BUILTIN_CASES).ready).toBe(false);
  });

  it("似た事例のどれよりも高い水準と、事例より大きい費用を、過大の可能性として示す", () => {
    const decisions = { "av.rate": dec("L4"), "av.rto": dec("L4"), "av.disaster": dec("L3"), "pf.response": dec("L3") };
    const ev = evaluateNfr(small, decisions);
    const r = reviewSizing(small, decisions, BUILTIN_CASES, { chosenCost: ev.cost.chosen + 30 });
    const keys = r.findings.flatMap((f) => f.items);
    expect(keys).toEqual(expect.arrayContaining(["av.rate", "av.rto", "av.disaster", "pf.response"]));
    expect(r.findings.some((f) => f.message.includes("似た事例の平均"))).toBe(true);
    // 理由を書けば、事例との比較の指摘は消える
    const r2 = reviewSizing(small, { "av.rate": dec("L4", "予約金の決済があるため") }, BUILTIN_CASES);
    expect(r2.findings.filter((f) => f.items.includes("av.rate"))).toEqual([]);
  });

  it("推奨より高い水準・業務の実態に合わない水準を過大の可能性として示す", () => {
    const ev = evaluateNfr(small, { "av.rto": dec("L4"), "av.disaster": dec("L3"), "pf.users": dec("L3"), "us.learn": dec("L3") });
    const msgs = ev.findings.map((f) => `${f.severity}:${f.items.join("+")}`);
    expect(msgs).toEqual(expect.arrayContaining(["warning:av.rto+av.disaster", "warning:pf.users", "error:av.rto", "warning:av.disaster", "error:pf.users"]));
    // 予算が小さいときは、費用のかかる項目の推奨を「中」までにする（情報の保護は下げない）
    expect(recommendedLevel(NFR_ITEM_BY_KEY.get("us.access")!, small).id).toBe("L2");
    expect(recommendedLevel(NFR_ITEM_BY_KEY.get("us.access")!, { ...small, budget: 1 }).id).toBe("L3");
    expect(recommendedLevel(NFR_ITEM_BY_KEY.get("sc.data")!, small).id).toBe("L3");
    expect(evaluateNfr({ hours: 0 }, { "av.hours": dec("L3", "夜間バッチのため") }).findings.some((f) => f.message.includes("24時間365日"))).toBe(true);
  });

  it("組織の過去のプロジェクトを事例にする（6割以上決まっているもの）", () => {
    const all = Object.fromEntries(NFR_ITEMS.map((i) => [i.key, dec("L1")]));
    expect(orgCaseFrom("p1", "旧予約", "", small, all)).toMatchObject({ id: "org-p1", name: "社内事例：旧予約", source: "org" });
    expect(orgCaseFrom("p2", "途中", "", small, { "av.rate": dec("L2") })).toBeNull();
  });

  it("複数AIに過大な水準を見直させ、票数と下げる先の水準をまとめる", async () => {
    const decisions = { "av.rate": dec("L4"), "av.rto": dec("L3", "顧客との契約で決まっている"), "pf.response": dec("L2") };
    const r = await reviewSizingWithAi([new MockProvider("a"), new MockProvider("b")], { projectName: "予約", purpose: "", profile: small, decisions, similar: BUILTIN_CASES.slice(0, 2) });
    expect(r.analysts).toBe(2);
    expect(r.items).toEqual([expect.objectContaining({ key: "av.rate", level: "L3", votes: 2, analysts: 2 })]);
  });
});
