import { readFileSync } from "node:fs";
import pg from "pg";
import type { RequirementItem } from "@arn/ai-core";
import type { Guide, ImplReport, UmlModel } from "@arn/ai-core";
import type {
  AuditEntry,
  AnalysisRecord,
  Baseline,
  NfrSheet,
  ChangeRequest,
  ProjectDocument,
  ChangeRequestPatch,
  ScreenFeedback,
  ScreenRecord,
  CredentialPatch,
  Decision,
  ExportItem,
  Integration,
  IntegrationPatch,
  Job,
  JobProgress,
  Org,
  Project,
  ProviderCredential,
  Requirement,
  RequirementPatch,
  RequirementVersion,
  Round,
  Store,
  TaskExport,
  TaskPlanRecord,
  UmlModelRecord,
  UmlRound,
  UsageRecord,
  AgentQuestion,
  ApiToken,
  ImplReportRecord,
  TestRunRecord,
  Webhook,
  ProjectSettings,
  ProjectSheet,
  ProjectSheetKind,
  Review,
  OrgMember,
  OrgMemberPatch,
} from "./store.js";

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

const toOrg = (r: any): Org => ({ id: r.id, name: r.name, monthlyTokenLimit: r.monthly_token_limit ?? null, createdAt: iso(r.created_at) });
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
  monthlyTokenLimit: r.monthly_token_limit ?? null,
  createdAt: iso(r.created_at),
  updatedAt: r.updated_at ? iso(r.updated_at) : null,
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
  settings: r.settings ?? {},
  archivedAt: r.archived_at ? iso(r.archived_at) : null,
});
const toMember = (r: any): OrgMember => ({
  id: r.id,
  orgId: r.org_id,
  email: r.email,
  userSub: r.user_sub ?? null,
  name: r.name,
  role: r.role,
  status: r.status,
  source: r.source,
  invitedBy: r.invited_by ?? null,
  lastSeenAt: r.last_seen_at ? iso(r.last_seen_at) : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
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
  phaseKey: r.phase_key ?? null,
  source: r.source,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: r.updated_at ? iso(r.updated_at) : null,
  deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
  ears: r.ears ?? null,
  rule: r.rule ?? null,
});
const toVersion = (r: any): RequirementVersion => ({
  requirementId: r.requirement_id,
  version: r.version,
  title: r.title,
  description: r.description,
  priority: r.priority,
  changedBy: r.changed_by,
  changeReason: r.change_reason,
  createdAt: iso(r.created_at),
});
const toAudit = (r: any): AuditEntry => ({
  id: String(r.id),
  orgId: r.org_id,
  actor: r.actor,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  detail: r.detail,
  at: iso(r.at),
});
const toJob = (r: any): Job => ({
  id: r.id,
  orgId: r.org_id,
  projectId: r.project_id,
  kind: r.kind,
  status: r.status,
  input: r.input,
  result: r.result,
  error: r.error,
  errorStatus: r.error_status,
  progress: r.progress,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  startedAt: r.started_at ? iso(r.started_at) : null,
  finishedAt: r.finished_at ? iso(r.finished_at) : null,
});
const toUmlRound = (r: any): UmlRound => ({
  id: r.id,
  projectId: r.project_id,
  candidates: r.candidates,
  evaluation: r.evaluation,
  failures: r.failures,
  warnings: r.warnings,
  status: r.status,
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

const toUml = (r: any): UmlModelRecord => ({
  id: r.id,
  projectId: r.project_id,
  model: r.model,
  providerId: r.provider_id,
  createdAt: iso(r.created_at),
});

const toIntegration = (r: any): Integration => ({
  id: r.id,
  orgId: r.org_id,
  kind: r.kind,
  label: r.label,
  config: r.config,
  encryptedSecret: r.encrypted_secret,
  secretLast4: r.secret_last4,
  createdAt: iso(r.created_at),
  updatedAt: r.updated_at ? iso(r.updated_at) : null,
});
const toPlan = (r: any): TaskPlanRecord => ({
  id: r.id,
  projectId: r.project_id,
  plan: r.plan,
  providerId: r.provider_id,
  basis: r.basis,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
const toExport = (r: any): TaskExport => ({
  id: r.id,
  projectId: r.project_id,
  planId: r.plan_id,
  integrationId: r.integration_id,
  kind: r.kind,
  target: r.target,
  items: r.items as ExportItem[],
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});

const toScreens = (r: any): ScreenRecord => ({
  id: r.id,
  projectId: r.project_id,
  model: r.model,
  providerId: r.provider_id,
  basis: r.basis,
  revision: r.revision,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
const toFeedback = (r: any): ScreenFeedback => ({
  id: r.id,
  projectId: r.project_id,
  screenKey: r.screen_key,
  text: r.text,
  level: r.level,
  detailHits: r.detail_hits,
  requirementHits: r.requirement_hits,
  status: r.status,
  revision: r.revision,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
const toBaseline = (r: any): Baseline => ({
  id: r.id,
  projectId: r.project_id,
  version: r.version,
  snapshot: r.snapshot,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
const toChange = (r: any): ChangeRequest => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  kind: r.kind,
  requirementId: r.requirement_id,
  requirementCode: r.requirement_code,
  proposal: r.proposal,
  reason: r.reason,
  status: r.status,
  impact: r.impact,
  decision: r.decision,
  source: r.source,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  updatedAt: r.updated_at ? iso(r.updated_at) : null,
});

const toDocument = (r: any): ProjectDocument => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  kind: r.kind,
  format: r.format,
  text: r.text,
  chars: r.chars,
  truncated: r.truncated,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
const toAnalysis = (r: any): AnalysisRecord => ({
  id: r.id,
  projectId: r.project_id,
  documentIds: r.document_ids,
  focus: r.focus,
  candidates: r.candidates,
  evaluation: r.evaluation,
  failures: r.failures,
  warnings: r.warnings,
  notes: r.notes,
  status: r.status,
  adoption: r.adoption,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});

const toToken = (r: any): ApiToken => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  tokenHash: r.token_hash,
  last4: r.last4,
  scopes: r.scopes,
  projectIds: r.project_ids ?? null,
  expiresAt: r.expires_at ? iso(r.expires_at) : null,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null,
  revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
});
const toImpl = (r: any): ImplReportRecord => ({
  id: r.id,
  projectId: r.project_id,
  requirementCode: r.requirement_code,
  status: r.status,
  requirementVersion: r.requirement_version,
  refs: r.refs,
  note: r.note,
  reportedBy: r.reported_by,
  at: iso(r.at),
});
const toTestRun = (r: any): TestRunRecord => ({
  id: r.id,
  projectId: r.project_id,
  tool: r.tool,
  revision: r.revision,
  url: r.url,
  format: r.format,
  tests: r.tests,
  requirements: r.requirements,
  unmatched: r.unmatched,
  summary: r.summary,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
const toQuestion = (r: any): AgentQuestion => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  requirementCode: r.requirement_code ?? null,
  text: r.text,
  context: r.context,
  askedBy: r.asked_by,
  status: r.status,
  answer: r.answer,
  answeredBy: r.answered_by ?? null,
  answeredAt: r.answered_at ? iso(r.answered_at) : null,
  createdAt: iso(r.created_at),
});
const toWebhook = (r: any): Webhook => ({
  id: r.id,
  orgId: r.org_id,
  url: r.url,
  events: r.events,
  encryptedSecret: r.encrypted_secret,
  lastStatus: r.last_status ?? null,
  lastAt: r.last_at ? iso(r.last_at) : null,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
});
const toReview = (r: any): Review => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  snapshot: r.snapshot,
  fingerprint: r.fingerprint,
  note: r.note,
  requiredApprovals: r.required_approvals,
  requestedBy: r.requested_by,
  status: r.status,
  decisions: r.decisions,
  createdAt: iso(r.created_at),
  closedAt: r.closed_at ? iso(r.closed_at) : null,
});
const toNfr = (r: any): NfrSheet => ({
  projectId: r.project_id,
  profile: r.profile,
  decisions: r.decisions,
  suggestions: r.suggestions,
  review: r.review ?? null,
  updatedAt: r.updated_at ? iso(r.updated_at) : null,
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
  async listOrgs() {
    const { rows } = await this.pool.query("SELECT * FROM orgs ORDER BY created_at");
    return rows.map(toOrg);
  }
  async renameOrg(id: string, name: string) {
    const { rows } = await this.pool.query("UPDATE orgs SET name = $2 WHERE id = $1 RETURNING *", [id, name]);
    return rows[0] ? toOrg(rows[0]) : null;
  }
  async listMembers(orgId: string) {
    const { rows } = await this.pool.query("SELECT * FROM org_members WHERE org_id = $1 ORDER BY created_at", [orgId]);
    return rows.map(toMember);
  }
  async findMemberships(q: { sub: string; email?: string }) {
    const { rows } = await this.pool.query("SELECT * FROM org_members WHERE user_sub = $1 OR ($2::text <> '' AND email = $2) ORDER BY created_at", [q.sub, (q.email ?? "").toLowerCase()]);
    return rows.map(toMember);
  }
  async addMember(m: Omit<OrgMember, "id" | "createdAt" | "updatedAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO org_members(org_id, email, user_sub, name, role, status, source, invited_by, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [m.orgId, m.email.toLowerCase(), m.userSub, m.name, m.role, m.status, m.source, m.invitedBy, m.lastSeenAt],
    );
    return toMember(rows[0]);
  }
  async updateMember(orgId: string, id: string, patch: OrgMemberPatch) {
    const cols: Record<string, string> = { userSub: "user_sub", name: "name", role: "role", status: "status", lastSeenAt: "last_seen_at", email: "email" };
    const sets: string[] = [];
    const vals: unknown[] = [orgId, id];
    for (const [k, col] of Object.entries(cols)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v === undefined) continue;
      vals.push(k === "email" && typeof v === "string" ? v.toLowerCase() : v);
      sets.push(`${col} = $${vals.length}`);
    }
    const { rows } = await this.pool.query(`UPDATE org_members SET ${[...sets, "updated_at = now()"].join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`, vals);
    return rows[0] ? toMember(rows[0]) : null;
  }
  async deleteMember(orgId: string, id: string) {
    const r = await this.pool.query("DELETE FROM org_members WHERE org_id = $1 AND id = $2", [orgId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async setOrgLimit(id: string, monthlyTokenLimit: number | null) {
    const { rows } = await this.pool.query("UPDATE orgs SET monthly_token_limit = $2 WHERE id = $1 RETURNING *", [id, monthlyTokenLimit]);
    return rows[0] ? toOrg(rows[0]) : null;
  }

  async addCredential(c: Omit<ProviderCredential, "id" | "createdAt" | "updatedAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO provider_credentials(org_id, vendor, model, label, endpoint, encrypted_key, key_last4, is_local, monthly_token_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [c.orgId, c.vendor, c.model, c.label, c.endpoint, c.encryptedKey, c.keyLast4, c.isLocal, c.monthlyTokenLimit],
    );
    return toCred(rows[0]);
  }
  async updateCredential(orgId: string, id: string, patch: CredentialPatch) {
    const cols: Record<keyof CredentialPatch, string> = {
      model: "model",
      label: "label",
      endpoint: "endpoint",
      encryptedKey: "encrypted_key",
      keyLast4: "key_last4",
      monthlyTokenLimit: "monthly_token_limit",
    };
    const sets: string[] = [];
    const vals: unknown[] = [orgId, id];
    for (const [k, col] of Object.entries(cols) as Array<[keyof CredentialPatch, string]>) {
      if (patch[k] === undefined) continue;
      vals.push(patch[k]);
      sets.push(`${col} = $${vals.length}`);
    }
    sets.push("updated_at = now()");
    const { rows } = await this.pool.query(
      `UPDATE provider_credentials SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`,
      vals,
    );
    return rows[0] ? toCred(rows[0]) : null;
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
  async updateProject(id: string, patch: { name?: string; purpose?: string; archivedAt?: string | null; aiConfig?: Project["aiConfig"] }) {
    const { rows } = await this.pool.query(
      `UPDATE projects SET name = COALESCE($2, name), purpose = COALESCE($3, purpose),
         archived_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE archived_at END,
         ai_config = COALESCE($6::jsonb, ai_config) WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.purpose ?? null, patch.archivedAt !== undefined, patch.archivedAt ?? null, patch.aiConfig ? JSON.stringify(patch.aiConfig) : null],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }
  async deleteProject(id: string) {
    // 要件・設計・履歴などは ON DELETE CASCADE で消える。ジョブは参照が残らないように先に消す
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM jobs WHERE project_id = $1", [id]);
      const r = await client.query("DELETE FROM projects WHERE id = $1", [id]);
      await client.query("COMMIT");
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async listProjects(orgId: string) {
    const { rows } = await this.pool.query("SELECT * FROM projects WHERE org_id = $1 ORDER BY created_at DESC", [orgId]);
    return rows.map(toProject);
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

  async addRequirements(projectId: string, items: Array<RequirementItem & { roundId: string | null; source: string; phaseKey?: string | null }>) {
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
          `INSERT INTO requirements(project_id, code, type, title, description, priority, round_id, source, phase_key, ears, rule)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [projectId, code, it.type, it.title, it.description, it.priority, it.roundId, it.source, it.phaseKey ?? null, it.ears ? JSON.stringify(it.ears) : null, it.rule ? JSON.stringify(it.rule) : null],
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
    const { rows } = await this.pool.query(
      "SELECT * FROM requirements WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at, code",
      [projectId],
    );
    return rows.map(toReq);
  }
  async getRequirement(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM requirements WHERE id = $1", [id]);
    return rows[0] ? toReq(rows[0]) : null;
  }
  async updateRequirement(id: string, patch: RequirementPatch, actor: string, reason: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: cur } = await client.query("SELECT * FROM requirements WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      const r = cur[0];
      if (!r) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `INSERT INTO requirement_versions(requirement_id, version, title, description, priority, changed_by, change_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, r.version, r.title, r.description, r.priority, actor, reason],
      );
      const { rows } = await client.query(
        `UPDATE requirements SET title = $2, description = $3, priority = $4, ears = $5, rule = $6, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.title ?? r.title,
          patch.description ?? r.description,
          patch.priority ?? r.priority,
          patch.ears === undefined ? (r.ears === null || r.ears === undefined ? null : JSON.stringify(r.ears)) : patch.ears ? JSON.stringify(patch.ears) : null,
          patch.rule === undefined ? (r.rule === null || r.rule === undefined ? null : JSON.stringify(r.rule)) : patch.rule ? JSON.stringify(patch.rule) : null,
        ],
      );
      await client.query("COMMIT");
      return toReq(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async deleteRequirement(id: string) {
    const r = await this.pool.query("UPDATE requirements SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async listRequirementVersions(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM requirement_versions WHERE requirement_id = $1 ORDER BY version DESC", [id]);
    return rows.map(toVersion);
  }

  async saveGuide(projectId: string, guide: Guide) {
    await this.pool.query("INSERT INTO phase_guides(project_id, phase_key, guide) VALUES ($1,$2,$3)", [projectId, guide.phaseKey, JSON.stringify(guide)]);
  }
  async latestGuides(projectId: string) {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (phase_key) guide FROM phase_guides WHERE project_id = $1 ORDER BY phase_key, created_at DESC`,
      [projectId],
    );
    return rows.map((r: { guide: Guide }) => r.guide);
  }

  async addAudit(e: Omit<AuditEntry, "id" | "at">) {
    await this.pool.query(
      "INSERT INTO audit_logs(org_id, actor, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6)",
      [e.orgId, e.actor, e.action, e.targetType, e.targetId, JSON.stringify(e.detail)],
    );
  }
  async listAudit(orgId: string, q: { limit: number; before?: string; action?: string }) {
    const vals: unknown[] = [orgId];
    let where = "org_id = $1";
    if (q.before) {
      vals.push(q.before);
      where += ` AND id < $${vals.length}`;
    }
    if (q.action) {
      vals.push(`${q.action}%`);
      where += ` AND action LIKE $${vals.length}`;
    }
    vals.push(q.limit);
    const { rows } = await this.pool.query(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT $${vals.length}`, vals);
    return rows.map(toAudit);
  }
  async purgeAudit(before: Date) {
    const r = await this.pool.query("DELETE FROM audit_logs WHERE at < $1", [before]);
    return r.rowCount ?? 0;
  }

  async createJob(j: Pick<Job, "orgId" | "projectId" | "kind" | "input" | "createdBy">) {
    const { rows } = await this.pool.query(
      "INSERT INTO jobs(org_id, project_id, kind, input, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [j.orgId, j.projectId, j.kind, JSON.stringify(j.input), j.createdBy],
    );
    return toJob(rows[0]);
  }
  async claimJob() {
    const { rows } = await this.pool.query(
      `UPDATE jobs SET status = 'running', started_at = now()
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
    );
    return rows[0] ? toJob(rows[0]) : null;
  }
  async updateJobProgress(id: string, progress: JobProgress) {
    await this.pool.query("UPDATE jobs SET progress = $2 WHERE id = $1", [id, JSON.stringify(progress)]);
  }
  async finishJob(id: string, r: { status: "done" | "failed"; result?: unknown; error?: string; errorStatus?: number }) {
    await this.pool.query(
      "UPDATE jobs SET status = $2, result = $3, error = $4, error_status = $5, finished_at = now() WHERE id = $1",
      [id, r.status, r.result === undefined ? null : JSON.stringify(r.result), r.error ?? null, r.errorStatus ?? null],
    );
  }
  async getJob(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
    return rows[0] ? toJob(rows[0]) : null;
  }
  async failStaleJobs(startedBefore: Date) {
    const r = await this.pool.query(
      `UPDATE jobs SET status = 'failed', error = '処理が時間内に終わりませんでした', error_status = 504, finished_at = now()
       WHERE status = 'running' AND started_at < $1`,
      [startedBefore],
    );
    return r.rowCount ?? 0;
  }

  async saveUmlRound(r: Omit<UmlRound, "id" | "createdAt" | "status">) {
    const { rows } = await this.pool.query(
      "INSERT INTO uml_rounds(project_id, candidates, evaluation, failures, warnings) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [r.projectId, JSON.stringify(r.candidates), r.evaluation ? JSON.stringify(r.evaluation) : null, JSON.stringify(r.failures), JSON.stringify(r.warnings)],
    );
    return toUmlRound(rows[0]);
  }
  async getUmlRound(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM uml_rounds WHERE id = $1", [id]);
    return rows[0] ? toUmlRound(rows[0]) : null;
  }
  async markUmlRoundDecided(id: string) {
    await this.pool.query("UPDATE uml_rounds SET status = 'decided' WHERE id = $1", [id]);
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

  async saveUmlModel(projectId: string, model: UmlModel, providerId: string): Promise<UmlModelRecord> {
    const { rows } = await this.pool.query(
      "INSERT INTO uml_models(project_id, model, provider_id) VALUES ($1,$2,$3) RETURNING *",
      [projectId, JSON.stringify(model), providerId],
    );
    return toUml(rows[0]);
  }
  async latestUmlModel(projectId: string): Promise<UmlModelRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM uml_models WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
      [projectId],
    );
    return rows[0] ? toUml(rows[0]) : null;
  }

  async addIntegration(i: Omit<Integration, "id" | "createdAt" | "updatedAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO integrations(org_id, kind, label, config, encrypted_secret, secret_last4) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [i.orgId, i.kind, i.label, JSON.stringify(i.config), i.encryptedSecret, i.secretLast4],
    );
    return toIntegration(rows[0]);
  }
  async listIntegrations(orgId: string) {
    const { rows } = await this.pool.query("SELECT * FROM integrations WHERE org_id = $1 ORDER BY created_at", [orgId]);
    return rows.map(toIntegration);
  }
  async updateIntegration(orgId: string, id: string, patch: IntegrationPatch) {
    const cols: Record<keyof IntegrationPatch, string> = {
      label: "label",
      config: "config",
      encryptedSecret: "encrypted_secret",
      secretLast4: "secret_last4",
    };
    const sets: string[] = [];
    const vals: unknown[] = [orgId, id];
    for (const [k, col] of Object.entries(cols) as Array<[keyof IntegrationPatch, string]>) {
      if (patch[k] === undefined) continue;
      vals.push(k === "config" ? JSON.stringify(patch[k]) : patch[k]);
      sets.push(`${col} = $${vals.length}`);
    }
    sets.push("updated_at = now()");
    const { rows } = await this.pool.query(`UPDATE integrations SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`, vals);
    return rows[0] ? toIntegration(rows[0]) : null;
  }
  async deleteIntegration(orgId: string, id: string) {
    const r = await this.pool.query("DELETE FROM integrations WHERE org_id = $1 AND id = $2", [orgId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async saveTaskPlan(r: Omit<TaskPlanRecord, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      "INSERT INTO task_plans(project_id, plan, provider_id, basis, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [r.projectId, JSON.stringify(r.plan), r.providerId, JSON.stringify(r.basis), r.createdBy],
    );
    return toPlan(rows[0]);
  }
  async getTaskPlan(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM task_plans WHERE id = $1", [id]);
    return rows[0] ? toPlan(rows[0]) : null;
  }
  async latestTaskPlan(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM task_plans WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1", [projectId]);
    return rows[0] ? toPlan(rows[0]) : null;
  }
  async saveTaskExport(e: Omit<TaskExport, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO task_exports(project_id, plan_id, integration_id, kind, target, items, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [e.projectId, e.planId, e.integrationId, e.kind, e.target, JSON.stringify(e.items), e.createdBy],
    );
    return toExport(rows[0]);
  }
  async listTaskExports(planId: string) {
    const { rows } = await this.pool.query("SELECT * FROM task_exports WHERE plan_id = $1 ORDER BY created_at DESC, id", [planId]);
    return rows.map(toExport);
  }

  async saveScreens(r: Omit<ScreenRecord, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      "INSERT INTO screen_models(project_id, model, provider_id, basis, revision, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [r.projectId, JSON.stringify(r.model), r.providerId, JSON.stringify(r.basis), r.revision, r.createdBy],
    );
    return toScreens(rows[0]);
  }
  async latestScreens(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM screen_models WHERE project_id = $1 ORDER BY created_at DESC, revision DESC LIMIT 1", [projectId]);
    return rows[0] ? toScreens(rows[0]) : null;
  }
  async addScreenFeedback(f: Omit<ScreenFeedback, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO screen_feedback(project_id, screen_key, text, level, detail_hits, requirement_hits, status, revision, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [f.projectId, f.screenKey, f.text, f.level, JSON.stringify(f.detailHits), JSON.stringify(f.requirementHits), f.status, f.revision, f.createdBy],
    );
    return toFeedback(rows[0]);
  }
  async listScreenFeedback(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM screen_feedback WHERE project_id = $1 ORDER BY created_at, id", [projectId]);
    return rows.map(toFeedback);
  }
  async setScreenFeedbackStatus(ids: string[], status: ScreenFeedback["status"]) {
    if (!ids.length) return;
    await this.pool.query("UPDATE screen_feedback SET status = $2 WHERE id = ANY($1::uuid[])", [ids, status]);
  }

  async addBaseline(b: Omit<Baseline, "id" | "createdAt" | "version">) {
    const { rows } = await this.pool.query(
      `INSERT INTO baselines(project_id, version, snapshot, reason, created_by)
       VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM baselines WHERE project_id = $1), $2, $3, $4) RETURNING *`,
      [b.projectId, JSON.stringify(b.snapshot), b.reason, b.createdBy],
    );
    return toBaseline(rows[0]);
  }
  async latestBaseline(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM baselines WHERE project_id = $1 ORDER BY version DESC LIMIT 1", [projectId]);
    return rows[0] ? toBaseline(rows[0]) : null;
  }
  async listBaselines(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM baselines WHERE project_id = $1 ORDER BY version DESC", [projectId]);
    return rows.map(toBaseline);
  }

  async addChangeRequest(c: Omit<ChangeRequest, "id" | "code" | "createdAt" | "updatedAt" | "status" | "impact" | "decision">) {
    const { rows } = await this.pool.query(
      `INSERT INTO change_requests(project_id, code, kind, requirement_id, requirement_code, proposal, reason, status, source, created_by)
       VALUES ($1, (SELECT 'CR-' || lpad((count(*) + 1)::text, 3, '0') FROM change_requests WHERE project_id = $1), $2, $3, $4, $5, $6, 'open', $7, $8)
       RETURNING *`,
      [c.projectId, c.kind, c.requirementId, c.requirementCode, c.proposal ? JSON.stringify(c.proposal) : null, c.reason, c.source, c.createdBy],
    );
    return toChange(rows[0]);
  }
  async getChangeRequest(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM change_requests WHERE id = $1", [id]);
    return rows[0] ? toChange(rows[0]) : null;
  }
  async listChangeRequests(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM change_requests WHERE project_id = $1 ORDER BY created_at DESC, code DESC", [projectId]);
    return rows.map(toChange);
  }
  async updateChangeRequest(id: string, patch: ChangeRequestPatch) {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    if (patch.status !== undefined) {
      vals.push(patch.status);
      sets.push(`status = $${vals.length}`);
    }
    if (patch.impact !== undefined) {
      vals.push(patch.impact === null ? null : JSON.stringify(patch.impact));
      sets.push(`impact = $${vals.length}`);
    }
    if (patch.decision !== undefined) {
      vals.push(patch.decision === null ? null : JSON.stringify(patch.decision));
      sets.push(`decision = $${vals.length}`);
    }
    sets.push("updated_at = now()");
    const { rows } = await this.pool.query(`UPDATE change_requests SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals);
    return rows[0] ? toChange(rows[0]) : null;
  }

  async addDocument(d: Omit<ProjectDocument, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO documents(project_id, name, kind, format, text, chars, truncated, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [d.projectId, d.name, d.kind, d.format, d.text, d.chars, d.truncated, d.createdBy],
    );
    return toDocument(rows[0]);
  }
  async listDocuments(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM documents WHERE project_id = $1 ORDER BY created_at, id", [projectId]);
    return rows.map(toDocument);
  }
  async getDocument(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM documents WHERE id = $1", [id]);
    return rows[0] ? toDocument(rows[0]) : null;
  }
  async deleteDocument(id: string) {
    const r = await this.pool.query("DELETE FROM documents WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async saveAnalysis(a: Omit<AnalysisRecord, "id" | "createdAt" | "status" | "adoption">) {
    const { rows } = await this.pool.query(
      `INSERT INTO analyses(project_id, document_ids, focus, candidates, evaluation, failures, warnings, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        a.projectId,
        JSON.stringify(a.documentIds),
        a.focus,
        JSON.stringify(a.candidates),
        a.evaluation ? JSON.stringify(a.evaluation) : null,
        JSON.stringify(a.failures),
        JSON.stringify(a.warnings),
        JSON.stringify(a.notes),
        a.createdBy,
      ],
    );
    return toAnalysis(rows[0]);
  }
  async getAnalysis(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM analyses WHERE id = $1", [id]);
    return rows[0] ? toAnalysis(rows[0]) : null;
  }
  async listAnalyses(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM analyses WHERE project_id = $1 ORDER BY created_at DESC, id", [projectId]);
    return rows.map(toAnalysis);
  }
  async adoptAnalysis(id: string, adoption: NonNullable<AnalysisRecord["adoption"]>) {
    const { rows } = await this.pool.query("UPDATE analyses SET status = 'adopted', adoption = $2 WHERE id = $1 RETURNING *", [id, JSON.stringify(adoption)]);
    return rows[0] ? toAnalysis(rows[0]) : null;
  }

  async getNfrSheet(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM nfr_sheets WHERE project_id = $1", [projectId]);
    const r = rows[0];
    return r ? toNfr(r) : null;
  }
  async listNfrSheets(orgId: string) {
    const { rows } = await this.pool.query(
      "SELECT s.*, p.name AS project_name, p.purpose AS project_purpose FROM nfr_sheets s JOIN projects p ON p.id = s.project_id WHERE p.org_id = $1 ORDER BY s.updated_at DESC",
      [orgId],
    );
    return rows.map((r: any) => ({ ...toNfr(r), projectName: r.project_name, projectPurpose: r.project_purpose }));
  }
  async saveNfrSheet(sheet: Omit<NfrSheet, "updatedAt">): Promise<NfrSheet> {
    const { rows } = await this.pool.query(
      `INSERT INTO nfr_sheets(project_id, profile, decisions, suggestions, review, updated_at) VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (project_id) DO UPDATE SET profile = EXCLUDED.profile, decisions = EXCLUDED.decisions, suggestions = EXCLUDED.suggestions, review = EXCLUDED.review, updated_at = now()
       RETURNING *`,
      [
        sheet.projectId,
        JSON.stringify(sheet.profile),
        JSON.stringify(sheet.decisions),
        sheet.suggestions ? JSON.stringify(sheet.suggestions) : null,
        sheet.review ? JSON.stringify(sheet.review) : null,
      ],
    );
    return toNfr(rows[0]);
  }

  async addUsage(u: Omit<UsageRecord, "at">) {
    await this.pool.query(
      "INSERT INTO usage_records(org_id, provider_id, project_id, input_tokens, output_tokens) VALUES ($1,$2,$3,$4,$5)",
      [u.orgId, u.providerId, u.projectId, u.inputTokens, u.outputTokens],
    );
  }
  async usageSummary(orgId: string, since?: Date) {
    const { rows } = await this.pool.query(
      `SELECT provider_id, sum(input_tokens)::int AS i, sum(output_tokens)::int AS o, count(*)::int AS n
       FROM usage_records WHERE org_id = $1 AND at >= $2 GROUP BY provider_id ORDER BY provider_id`,
      [orgId, since ?? new Date(0)],
    );
    return rows.map((r: any) => ({ providerId: r.provider_id, inputTokens: r.i, outputTokens: r.o, calls: r.n }));
  }

  async createApiToken(t: Omit<ApiToken, "id" | "createdAt" | "lastUsedAt" | "revokedAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO api_tokens(org_id, name, token_hash, last4, scopes, project_ids, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [t.orgId, t.name, t.tokenHash, t.last4, JSON.stringify(t.scopes), t.projectIds ? JSON.stringify(t.projectIds) : null, t.expiresAt, t.createdBy],
    );
    return toToken(rows[0]);
  }
  async findApiToken(tokenHash: string) {
    const { rows } = await this.pool.query("SELECT * FROM api_tokens WHERE token_hash = $1", [tokenHash]);
    return rows[0] ? toToken(rows[0]) : null;
  }
  async listApiTokens(orgId: string) {
    const { rows } = await this.pool.query("SELECT * FROM api_tokens WHERE org_id = $1 ORDER BY created_at", [orgId]);
    return rows.map(toToken);
  }
  async revokeApiToken(orgId: string, id: string) {
    const r = await this.pool.query("UPDATE api_tokens SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL", [orgId, id]);
    return (r.rowCount ?? 0) > 0;
  }
  async touchApiToken(id: string) {
    await this.pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [id]);
  }
  async addImplReports(projectId: string, items: ImplReport[]) {
    const out: ImplReportRecord[] = [];
    for (const i of items) {
      const { rows } = await this.pool.query(
        `INSERT INTO impl_reports(project_id, requirement_code, status, requirement_version, refs, note, reported_by, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [projectId, i.requirementCode, i.status, i.requirementVersion, JSON.stringify(i.refs), i.note, i.reportedBy, i.at],
      );
      out.push(toImpl(rows[0]));
    }
    return out;
  }
  async listImplReports(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM impl_reports WHERE project_id = $1 ORDER BY at, id", [projectId]);
    return rows.map(toImpl);
  }
  async addTestRun(r: Omit<TestRunRecord, "id" | "createdAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO test_runs(project_id, tool, revision, url, format, tests, requirements, unmatched, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [r.projectId, r.tool, r.revision, r.url, r.format, JSON.stringify(r.tests), JSON.stringify(r.requirements), JSON.stringify(r.unmatched), JSON.stringify(r.summary), r.createdBy],
    );
    return toTestRun(rows[0]);
  }
  async listTestRuns(projectId: string, limit = 50) {
    const { rows } = await this.pool.query("SELECT * FROM test_runs WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", [projectId, limit]);
    return rows.map(toTestRun);
  }
  async addQuestion(q: Omit<AgentQuestion, "id" | "code" | "createdAt" | "status" | "answer" | "answeredBy" | "answeredAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO agent_questions(project_id, code, requirement_code, text, context, asked_by)
       VALUES ($1, (SELECT 'Q-' || lpad((count(*) + 1)::text, 3, '0') FROM agent_questions WHERE project_id = $1), $2, $3, $4, $5) RETURNING *`,
      [q.projectId, q.requirementCode, q.text, q.context, q.askedBy],
    );
    return toQuestion(rows[0]);
  }
  async getQuestion(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM agent_questions WHERE id = $1", [id]);
    return rows[0] ? toQuestion(rows[0]) : null;
  }
  async listQuestions(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM agent_questions WHERE project_id = $1 ORDER BY created_at DESC, code DESC", [projectId]);
    return rows.map(toQuestion);
  }
  async answerQuestion(id: string, a: { status: AgentQuestion["status"]; answer: string; answeredBy: string }) {
    const { rows } = await this.pool.query(
      "UPDATE agent_questions SET status = $2, answer = $3, answered_by = $4, answered_at = now() WHERE id = $1 RETURNING *",
      [id, a.status, a.answer, a.answeredBy],
    );
    return rows[0] ? toQuestion(rows[0]) : null;
  }
  async addWebhook(w: Omit<Webhook, "id" | "createdAt" | "lastStatus" | "lastAt">) {
    const { rows } = await this.pool.query(
      "INSERT INTO webhooks(org_id, url, events, encrypted_secret, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [w.orgId, w.url, JSON.stringify(w.events), w.encryptedSecret, w.createdBy],
    );
    return toWebhook(rows[0]);
  }
  async listWebhooks(orgId: string) {
    const { rows } = await this.pool.query("SELECT * FROM webhooks WHERE org_id = $1 ORDER BY created_at", [orgId]);
    return rows.map(toWebhook);
  }
  async deleteWebhook(orgId: string, id: string) {
    const r = await this.pool.query("DELETE FROM webhooks WHERE org_id = $1 AND id = $2", [orgId, id]);
    return (r.rowCount ?? 0) > 0;
  }
  async recordWebhookDelivery(id: string, status: string) {
    await this.pool.query("UPDATE webhooks SET last_status = $2, last_at = now() WHERE id = $1", [id, status]);
  }

  async updateProjectSettings(id: string, settings: ProjectSettings) {
    const { rows } = await this.pool.query("UPDATE projects SET settings = $2 WHERE id = $1 RETURNING *", [id, JSON.stringify(settings)]);
    return rows[0] ? toProject(rows[0]) : null;
  }
  async getProjectSheet<T>(projectId: string, kind: ProjectSheetKind): Promise<ProjectSheet<T> | null> {
    const { rows } = await this.pool.query("SELECT * FROM project_sheets WHERE project_id = $1 AND kind = $2", [projectId, kind]);
    const r = rows[0];
    return r ? { projectId: r.project_id, kind: r.kind, data: r.data, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) } : null;
  }
  async saveProjectSheet<T>(projectId: string, kind: ProjectSheetKind, data: T, updatedBy: string): Promise<ProjectSheet<T>> {
    const { rows } = await this.pool.query(
      `INSERT INTO project_sheets(project_id, kind, data, updated_by, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (project_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
      [projectId, kind, JSON.stringify(data), updatedBy],
    );
    const r = rows[0];
    return { projectId: r.project_id, kind: r.kind, data: r.data, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) };
  }
  async addReview(r: Omit<Review, "id" | "code" | "status" | "decisions" | "createdAt" | "closedAt">) {
    const { rows } = await this.pool.query(
      `INSERT INTO reviews(project_id, code, snapshot, fingerprint, note, required_approvals, requested_by)
       VALUES ($1, (SELECT 'RV-' || lpad((count(*) + 1)::text, 3, '0') FROM reviews WHERE project_id = $1), $2, $3, $4, $5, $6) RETURNING *`,
      [r.projectId, JSON.stringify(r.snapshot), r.fingerprint, r.note, r.requiredApprovals, r.requestedBy],
    );
    return toReview(rows[0]);
  }
  async getReview(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM reviews WHERE id = $1", [id]);
    return rows[0] ? toReview(rows[0]) : null;
  }
  async listReviews(projectId: string) {
    const { rows } = await this.pool.query("SELECT * FROM reviews WHERE project_id = $1 ORDER BY created_at DESC, code DESC", [projectId]);
    return rows.map(toReview);
  }
  async updateReview(id: string, patch: Partial<Pick<Review, "status" | "decisions" | "closedAt">>) {
    const cur = await this.getReview(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    const { rows } = await this.pool.query("UPDATE reviews SET status = $2, decisions = $3, closed_at = $4 WHERE id = $1 RETURNING *", [id, next.status, JSON.stringify(next.decisions), next.closedAt]);
    return rows[0] ? toReview(rows[0]) : null;
  }
}
