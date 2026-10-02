import { describe, expect, it } from "vitest";
import { CandidateContent, Ears, lintEars, normalizeResponse, renderEars, runRound, MockProvider } from "../src/index.js";

const e = (x: Partial<Ears> & { response: string }) => Ears.parse({ system: "予約システム", ...x });

describe("EARS記法", () => {
  it("型ごとの文型で要件文を組み立てる", () => {
    expect(renderEars(e({ pattern: "ubiquitous", response: "予約の履歴を保存しなければならない" }))).toBe("予約システムは、予約の履歴を保存しなければならない。");
    expect(renderEars(e({ pattern: "event", trigger: "利用者が予約を確定した", response: "確認メールを3分以内に送信する" }))).toBe(
      "利用者が予約を確定したとき、予約システムは、確認メールを3分以内に送信しなければならない。",
    );
    expect(renderEars(e({ pattern: "state", state: "予約の受付期間中である", response: "空き枠を表示" }))).toBe(
      "予約の受付期間中である間、予約システムは、空き枠を表示しなければならない。",
    );
    expect(renderEars(e({ pattern: "state", state: "保守作業中", response: "利用者に停止中であることを表示" }))).toBe(
      "保守作業中の間、予約システムは、利用者に停止中であることを表示しなければならない。",
    );
    expect(renderEars(e({ pattern: "unwanted", trigger: "決済に失敗した場合", response: "予約を仮予約のまま保持すること" }))).toBe(
      "決済に失敗した場合、予約システムは、予約を仮予約のまま保持しなければならない。",
    );
    expect(renderEars(e({ pattern: "optional", feature: "多言語表示の機能", response: "利用者が言語を選べるようにする" }))).toBe(
      "多言語表示の機能がある場合、予約システムは、利用者が言語を選べるようにしなければならない。",
    );
    expect(renderEars(e({ pattern: "complex", state: "予約の受付期間中である", trigger: "空き枠がなくなった", response: "キャンセル待ちの受付を案内しなければならない" }))).toBe(
      "予約の受付期間中である間に空き枠がなくなったとき、予約システムは、キャンセル待ちの受付を案内しなければならない。",
    );
    expect(normalizeResponse("二重予約を受け付けない")).toBe("二重予約を受け付けないようにしなければならない");
    expect(Ears.parse({ pattern: "謎", response: "x" }).pattern).toBe("ubiquitous");
  });

  it("要件文の振れの原因を検査する", () => {
    expect(lintEars("利用者が予約を確定したとき、予約システムは、確認メールを3分以内に送信しなければならない。")).toEqual({ pattern: "event", ok: true, issues: [] });
    const bad = lintEars("予約はなるべく早く確認できるなど、使いやすい画面にする");
    expect(bad.ok).toBe(false);
    expect(bad.pattern).toBeNull();
    expect(bad.issues.join("\n")).toContain("しなければならない");
    expect(bad.issues.join("\n")).toContain("「など」");
    expect(bad.issues.join("\n")).toContain("「早く」はあいまいです");
    expect(lintEars("システムは、予約を保存しなければならず、メールを送信しなければならない。").issues).toContain("1文に複数の要件が含まれています。要件ごとに分けてください");
    expect(lintEars("決済に失敗した場合、システムは、仮予約にしなければならない。").pattern).toBe("unwanted");
    // 目的・制約は対象外
    expect(lintEars("電話予約を減らす", "BR").ok).toBe(true);
  });

  it("要件案の EARS の構造から文を組み立て、対象外の区分では構造を捨てる", () => {
    const c = CandidateContent.parse({
      items: [
        { type: "FR", ears: { pattern: "event", trigger: "予約が確定した", system: "予約システム", response: "通知する" } },
        { title: "電話予約を減らす", type: "BR", ears: { response: "x" } },
      ],
    });
    expect(c.items[0]!.title).toBe("予約が確定したとき、予約システムは、通知しなければならない。");
    expect(c.items[1]).toEqual({ title: "電話予約を減らす", description: "", type: "BR", priority: "should" });
    expect(() => CandidateContent.parse({ items: [{ type: "FR" }] })).toThrow();
  });

  it("ヒアリングの案と統合案が EARS の文になる", async () => {
    const r = await runRound(
      { phase: { key: "functions", name: "機能", type: "FR", question: "q", checklist: [], defaultOptions: [], hint: "" } as never, projectName: "p", projectPurpose: "", existingRequirements: [], userAnswer: "ネットで予約したい" },
      { generators: [new MockProvider("a"), new MockProvider("b")], evaluator: new MockProvider("c"), random: () => 0.5 },
    );
    for (const it of [...r.candidates.flatMap((c) => c.content.items), ...r.evaluation!.merged.items]) {
      expect(lintEars(it.title, it.type).ok).toBe(true);
    }
  });
});
