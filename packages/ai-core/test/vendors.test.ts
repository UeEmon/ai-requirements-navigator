import { describe, expect, it } from "vitest";
import { checkApiKey, guessKeyVendor, VENDOR_INFO, vendorName } from "../src/index.js";

describe("AI の種類ごとの名前と API キーの確認", () => {
  it("Claude・ChatGPT・Gemini が標準のAIで、キーの名前・発行場所・料金の注意を持つ", () => {
    const std = Object.values(VENDOR_INFO).filter((v) => v.standard);
    expect(std.map((v) => v.name)).toEqual(["Claude", "ChatGPT", "Gemini"]);
    for (const v of std) {
      expect(v.keyName).toContain("APIキー");
      expect(v.keyUrl).toMatch(/^https:\/\//);
      expect(v.keyHow).toBeTruthy();
      expect(v.billingNote).toBeTruthy();
    }
    expect(VENDOR_INFO.ollama.keyName).toBeNull();
    expect(vendorName("openai")).toBe("ChatGPT");
  });

  it("キーの先頭から AI を推定する", () => {
    expect(guessKeyVendor("sk-ant-api03-abc")).toBe("anthropic");
    expect(guessKeyVendor("sk-proj-abc")).toBe("openai");
    expect(guessKeyVendor("AIzaSyabc")).toBe("gemini");
    expect(guessKeyVendor("AQ.Ab8abc")).toBe("gemini");
    expect(guessKeyVendor("xyz")).toBeNull();
  });

  it("前後の空白・引用符・Bearer を取り除く", () => {
    expect(checkApiKey("anthropic", '  "sk-ant-api03-abcd"  ')).toEqual({ ok: true, key: "sk-ant-api03-abcd" });
    expect(checkApiKey("openai", "Bearer sk-proj-abcd")).toEqual({ ok: true, key: "sk-proj-abcd" });
  });

  it("別の AI のキー・管理用キー・空白や全角文字を止め、キーそのものはメッセージに出さない", () => {
    const cases: Array<[Parameters<typeof checkApiKey>[0], string, string]> = [
      ["anthropic", "sk-proj-SECRET1", "ChatGPT のキーの形式です"],
      ["openai", "sk-ant-api03-SECRET2", "Claude のキーの形式です"],
      ["gemini", "sk-ant-api03-SECRET3", "種類「Claude」で登録"],
      ["anthropic", "AIzaSECRET4", "Gemini のキーの形式です"],
      ["anthropic", "sk-ant-admin01-SECRET5", "管理用キー"],
      ["gemini", "AIzaSECRET6 Digest: sha256:abc", "空白や改行"],
      ["openai", "sk-ＳＥＣＲＥＴ7", "全角文字"],
      ["openai", "   ", "ChatGPT（OpenAI）APIキーが空です"],
    ];
    for (const [v, k, m] of cases) {
      const r = checkApiKey(v, k);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain(m);
        expect(r.message).not.toMatch(/SECRET|ＳＥＣＲＥＴ/);
      }
    }
  });

  it("見慣れない形式は止めない。接続先を変えているときやローカルLLMは形式を確かめない", () => {
    expect(checkApiKey("gemini", "NEWFORMAT-123").ok).toBe(true);
    expect(checkApiKey("anthropic", "sk-proj-abc", { customEndpoint: true }).ok).toBe(true);
    expect(checkApiKey("ollama", "sk-ant-x").ok).toBe(true);
  });
});
