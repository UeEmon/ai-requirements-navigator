import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keyGuides, VENDOR_INFO } from "../src/index.js";

describe("自動で取得できないキー・トークンの取得方法", () => {
  it("Claude・ChatGPT（管理用キー・APIキー）・Gemini・GitHub・Jira・Backlog の取得ページと手順がある", () => {
    const { manual, auto } = keyGuides({ googleOAuth: false });
    expect(manual.map((k) => k.id)).toEqual(["claude", "openai-admin", "openai", "gemini", "github", "jira", "backlog"]);
    for (const k of manual) {
      expect(k.url).toMatch(/^https:\/\//);
      expect(k.steps.length).toBeGreaterThanOrEqual(3);
      expect(k.where).toMatch(/^「(AI設定|プロジェクト設定)」/);
    }
    // 画面の AI の登録と同じ発行場所
    expect(manual.find((k) => k.id === "claude")!.url).toBe(VENDOR_INFO.anthropic.keyUrl);
    expect(manual.find((k) => k.id === "openai")!.url).toBe(VENDOR_INFO.openai.keyUrl);
    expect(manual.find((k) => k.id === "gemini")!.url).toBe(VENDOR_INFO.gemini.keyUrl);
    expect(manual.find((k) => k.id === "openai-admin")!.url).toBe((VENDOR_INFO.openai.autoIssue as { adminKeyUrl: string }).adminKeyUrl);
    expect(auto.map((a) => a.target)).toEqual(["ChatGPT"]);
  });

  it("Google のログインが設定されていれば、Gemini は自動で取得できるものに入る", () => {
    const g = keyGuides({ googleOAuth: true });
    expect(g.auto.map((a) => a.target)).toEqual(["ChatGPT", "Gemini"]);
    expect(g.manual.find((k) => k.id === "gemini")!.autoAlternative).toContain("Google でログイン");
  });

  it("docs/ai-keys.md に、すべての取得ページと手順が載っている", () => {
    const md = readFileSync(new URL("../../../docs/ai-keys.md", import.meta.url), "utf8");
    for (const k of keyGuides({ googleOAuth: false }).manual) {
      expect(md).toContain(`### ${k.name}`);
      expect(md).toContain(`(${k.url})`);
      for (const s of k.steps) expect(md).toContain(s);
    }
  });
});
