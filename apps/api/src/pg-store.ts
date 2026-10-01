import { readFileSync } from "node:fs";
import pg from "pg";
import type { RequirementItem } from "@arn/ai-core";
import type { Decision, Org, Project, ProviderCredential, Requirement, Round, Store, UsageRecord } from "./store.js";

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

const toOrg = (r: any): Org => ({ id: r.id, name: r.name, createdAt: iso(r.created_at) });
const toCred = (r: any): ProviderCredential => ({
  id: r.id,
  orgId: r.org_id,
  vendor: r.vendor,
  model: r.model,
  label: r.label,
  endpoint: r.endpoint,
  encryptedKey: r.encrypted_key,
  keyLast4: r.key_last4,
  isLocal: r.is_local,
  createdAt: iso(r.created_at),
});
const toProject = (r: any): Project => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  purpose: r.purpose,
  confidential: r.confidential,
  phaseKey: r.phase_key,
  aiConfig: r.ai_config,
  createdAt: iso(r.created_at),
});
const toRound = (r: any): Round => ({
  id: r.id,
  projectId: r.project_id,
  phaseKey: r.phase_key,
  answer: r.answer,
  candidates: r.candidates,
  evaluation: r.evaluation,
  failures: r.failures,
  warnings: r.warnings,
  status: r.status,
  createdAt: iso(r.created_at),
});
const toReq = (r: any): Requirement => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  type: r.type,
  title: r.title,
  description: r.description,
  priority: r.priority,
  roundId: r.round_id,
  source: r.source,
  version: r.version,
  createdAt: iso(r.created_at),
});
const toDecision = (r: any): Decision => ({
  id: r.id,
  projectId: r.project_id,
  roundId: r.round_id,
  pick: r.pick,
  reason: r.reason,
  mapping: r.mapping,
  createdAt: iso(r.created_at),
});

/** PostgreSQL（ローカルDockerの postgres / AWS RDS）に保存する */
export class PgStore implements Store {
  constructor(readonly pool: pg.Pool) {}

  /** ssl を有効にする場合、caFile（例: RDSのCAバンドル）で証明書を検証する */
  static fromUrl(url: string, ssl = false, caFile?: string): PgStore {
    const sslOpt = ssl ? { rejectUnauthorized: true, ca: caFile ? readFileSync(caFile, "utf8") : undefined } : undefined;
    return new PgStore(new pg.Pool({ connectionString: url, ssl: sslOpt, max: 10 }));
  }

  async createOrg(name: string) {
    const { rows } = await this.pool.query("INSERT INTO orgs(name) VALUES ($1) RETURNING *", [name]);
    return toOrg(rows[0]);
  }
  async getOrg(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM orgs WHERE id = $1", [id]);
    return rows[0] ? toOrg(rows[0]) : null;
  }

  async addCredential(c: Omit<ProviderCredential, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO provider_credentials(org_id, vendor, model, label, endpoint, encrypted_key, key_last4, is_local)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [c.orgId, c.vendor, c.model, c.label, c.endpoint, c.encryptedKey, c.keyLast4, c.isLocal],
    );
    return toCred(rows[0]);
  }
  async listCredentials(orgId: string) {
    const { rows } = await this.pool.query("SELECT * FROM provider_credentials WHERE org_id = $1 ORDER BY created_at", [orgId]);
    return rows.map(toCred);
  }
  async deleteCredential(orgId: string, id: string) {
    const r = await this.pool.query("DELETE FROM provider_credentials WHERE org_id = $1 AND id = $2", [orgId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async createProject(p: Omit<Project, "id" | "createdAt" | "phaseKey">) {
    const { rows } = await this.pool.query(
      `INSERT INTO projects(org_id, name, purpose, confidential, ai_config) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [p.orgId, p.name, p.purpose, p.confidential, JSON.stringify(p.aiConfig)],
    );
    return toProject(rows[0]);
  }
  async getProject(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    return rows[0] ? toProject(rows[0]) : null;
  }
  async setProjectPhase(id: string, phaseKey: string) {
    await this.pool.query("UPDATE projects SET phase_key = $2 WHERE id = $1", [id, phaseKey]);
  }

  async saveRound(r: Omit<Round, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO rounds(project_id, phase_key, answer, candidates, evaluation, failures, warnings, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        r.projectId,
        r.phaseKey,
        r.answer,
        JSON.stringify(r.candidates),
        r.evaluation ? JSON.stringify(r.evaluation) : null,
        JSON.stringify(r.failures),
        JSON.stringify(r.warnings),
        r.status,
      ],
    );
    return toRound(rows[0]);
  }
  async getRound(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM rounds WHERE id = $1", [id]);
    return rows[0] ? toRound(rows[0]) : null;
  }
  async markRoundDecided(id: string) {
    await this.pool.query("UPDATE rounds SET status = 'decided' WHERE id = $1", [id]);
  }

  async addRequirements(projectId: string, items: Array<RequirementItem & { roundId: string | null; source: string }>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 同じプロジェクトへの同時採番を直列化する
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [projectId]);
      const out: Requirement[] = [];
      for (const it of items) {
        const { rows: c } = await client.query(
          "SELECT count(*)::int AS n FROM requirements WHERE project_id = $1 AND type = $2",
          [projectId, it.type],
        );
        const code = `${it.type}-${String((c[0]?.n ?? 0) + 1).padStart(2, "0")}`;
        const { rows } = await client.query(
          `INSERT INTO requirements(project_id, code, type, title, description, priority, round_id, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [projectId, code, it.type, it.title, it.description, it.priority, it.roundId, it.source],
        );
        out.push(toReq(rows[0]));
      }
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async listRequirements(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM requirements WHERE project_id = $1 ORDER BY created_at, code", [projectId]);
    return rows.map(toReq);
  }

  async addDecision(d: Omit<Decision, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO decisions(project_id, round_id, pick, reason, mapping) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [d.projectId, d.roundId, d.pick, d.reason, JSON.stringify(d.mapping)],
    );
    return toDecision(rows[0]);
  }
  async listDecisions(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM decisions WHERE project_id = $1 ORDER BY created_at", [projectId]);
    return rows.map(toDecision);
  }

  async addUsage(u: Omit<UsageRecord, "at">) {
    await this.pool.query(
      "INSERT INTO usage_records(org_id, provider_id, project_id, input_tokens, output_tokens) VALUES ($1,$2,$3,$4,$5)",
      [u.orgId, u.providerId, u.projectId, u.inputTokens, u.outputTokens],
    );
  }
  async usageSummary(orgId: string) {
    const { rows } = await this.pool.query(
      `SELECT provider_id, sum(input_tokens)::int AS i, sum(output_tokens)::int AS o, count(*)::int AS n
       FROM usage_records WHERE org_id = $1 GROUP BY provider_id ORDER BY provider_id`,
      [orgId],
    );
    return rows.map((r: any) => ({ providerId: r.provider_id, inputTokens: r.i, outputTokens: r.o, calls: r.n }));
  }
}
