import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

/**
 * db/migrations/*.sql を番号順に1回だけ適用する。
 * 複数のコンテナ（やテスト）が同時に起動しても1つずつ適用するよう、ロックを取ってから進める
 */
export async function migrate(pool: pg.Pool, dir: string, log: (m: string) => void = console.log): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('arn:migrate'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r: { name: string }) => r.name));
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
        log(`migrated ${f}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('arn:migrate'))").catch(() => {});
    client.release();
  }
}

/** 接続先が見つからない・まだ受け付けていないときのエラー（待てば直る見込みがあるもの） */
const RETRYABLE = new Set(["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P03"]);

/**
 * データベースにつながるまで待つ。
 * docker compose で db より先に app が動き出したときや、db コンテナが再起動中のときに、すぐ終了しないようにする。
 * ログには接続先のホスト名だけを出す（パスワードを含む DATABASE_URL は出さない）
 */
export async function waitForDb(
  pool: Pick<pg.Pool, "query">,
  opts: { host?: string; timeoutMs?: number; intervalMs?: number; log?: (m: string) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const { host = "データベース", timeoutMs = 60_000, intervalMs = 2_000, log = console.warn } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  for (;;) {
    try {
      await pool.query("SELECT 1");
      if (waited > 0) log(`データベース（${host}）に接続しました`);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (!RETRYABLE.has(code)) throw e;
      if (waited >= timeoutMs) {
        throw new Error(
          `データベース（${host}）に ${Math.round(timeoutMs / 1000)} 秒たっても接続できません（${code}）。` +
            "docker compose を使っているときは、app だけでなく db も動いているかを `docker compose ps` で確かめ、" +
            "`docker compose up -d` で両方を起動してください",
        );
      }
      if (waited === 0) log(`データベース（${host}）の起動を待っています（${code}）`);
      await sleep(intervalMs);
      waited += intervalMs;
    }
  }
}
