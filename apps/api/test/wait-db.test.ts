import { describe, expect, it } from "vitest";
import { waitForDb } from "../src/migrate.js";

const err = (code: string) => Object.assign(new Error(`getaddrinfo ${code} db`), { code });

describe("起動時にデータベースを待つ", () => {
  it("名前が引けない間は待ち、つながったら進む", async () => {
    let calls = 0;
    const logs: string[] = [];
    const pool = { query: async () => (++calls < 3 ? Promise.reject(err("EAI_AGAIN")) : { rows: [] }) };
    await waitForDb(pool as never, { host: "db", log: (m) => logs.push(m), sleep: async () => {} });
    expect(calls).toBe(3);
    expect(logs[0]).toContain("待っています");
    expect(logs.at(-1)).toContain("接続しました");
  });

  it("時間内につながらなければ、起動手順を示して終了する", async () => {
    const pool = { query: async () => Promise.reject(err("EAI_AGAIN")) };
    await expect(waitForDb(pool as never, { host: "db", timeoutMs: 4000, intervalMs: 2000, log: () => {}, sleep: async () => {} })).rejects.toThrow(
      /docker compose up -d/,
    );
  });

  it("認証の失敗など、待っても直らないエラーはすぐに返す", async () => {
    let calls = 0;
    const pool = { query: async () => (calls++, Promise.reject(err("28P01"))) };
    await expect(waitForDb(pool as never, { log: () => {}, sleep: async () => {} })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
