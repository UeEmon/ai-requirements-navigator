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
