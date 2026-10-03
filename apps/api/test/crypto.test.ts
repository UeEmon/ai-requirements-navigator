import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalKeyEncryptor, parseMasterKey } from "../src/crypto.js";

describe("MASTER_KEY の読み取り", () => {
  const good = randomBytes(32).toString("base64");

  it("前後の空白・引用符・末尾の = の省略を受け付ける", async () => {
    for (const v of [good, ` ${good} `, `"${good}"`, `'${good}'`, good.replace(/=+$/, "")]) expect(parseMasterKey(v).length).toBe(32);
    const e = new LocalKeyEncryptor(` "${good}" `);
    expect(await e.decrypt(await e.encrypt("秘密", { orgId: "o" }), { orgId: "o" })).toBe("秘密");
  });

  it("何が違うかを示し、鍵そのものはメッセージに出さない", () => {
    const msg = (v: string) => {
      try {
        parseMasterKey(v);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(msg("")).toContain("MASTER_KEY が空です");
    expect(msg("Digest: sha256:" + "a".repeat(64))).toContain("Base64 で使わない文字");
    expect(msg("表示された文字列")).toContain("Base64 で使わない文字");
    const short = randomBytes(16).toString("base64");
    expect(msg(short)).toContain("いまは24文字、16バイト");
    expect(msg(short)).not.toContain(short);
  });
});
