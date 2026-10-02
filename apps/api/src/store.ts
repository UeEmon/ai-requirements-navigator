import { randomUUID } from "node:crypto";
import type { CandidateContent, Guide, RequirementItem, RequirementType, ScoredEvaluation, TaskPlan, UmlComparison, UmlModel, Usage, Vendor } from "@arn/ai-core";

export interface Org {
  id: string;
  name: string;
  /** 組織全体の月間トークン上限（入力＋出力）。null は上限なし */
  monthlyTokenLimit: number | null;
  createdAt: string;
}

/** 組織の管理者が登録したAIの接続情報。APIキーは暗号化して保存する */
export interface ProviderCredential {
  id: string;
  orgId: string;
  vendor: Vendor;
  model: string;
  label: string;
  endpoint: string | null;
  encryptedKey: string | null;
  keyLast4: string | null;
  isLocal: boolean;
  /** このAIの月間トークン上限。null は上限なし */
  monthlyTokenLimit: number | null;
  createdAt: string;
  updatedAt: string | null;
}

/** 登録後に変更できる項目（種類は変更不可） */
export type CredentialPatch = Partial<Pick<ProviderCredential, "model" | "label" | "endpoint" | "encryptedKey" | "keyLast4" | "monthlyTokenLimit">>;

export interface UsageRow {
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface AIConfig {
  mode: "single" | "multi";
  generatorIds: string[];
  evaluatorId: string | null;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  purpose: string;
  confidential: boolean;
  phaseKey: string;
  aiConfig: AIConfig;
  createdAt: string;
}

export interface StoredCandidate {
  label: string;
  providerId: string;
  content: CandidateContent;
}

export interface Round {
  id: string;
  projectId: string;
  phaseKey: string;
  answer: string;
  candidates: StoredCandidate[];
  evaluation: ScoredEvaluation | null;
  failures: Array<{ providerId: string; reason: string }>;
  warnings: string[];
  status: "awaiting_decision" | "decided";
  createdAt: string;
}

export interface Requirement {
  id: string;
  projectId: string;
  code: string;
  type: RequirementType;
  title: string;
  description: string;
  priority: RequirementItem["priority"];
  roundId: string | null;
  /** どのフェーズのヒアリングで確定したか */
  phaseKey: string | null;
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
}

export interface RequirementVersion {
  requirementId: string;
  version: number;
  title: string;
  description: string;
  priority: string;
  changedBy: string;
  changeReason: string;
  createdAt: string;
}

export type RequirementPatch = Partial<Pick<Requirement, "title" | "description" | "priority">>;

export interface AuditEntry {
  id: string;
  orgId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  at: string;
}

export type JobKind = "round" | "uml" | "tasks" | "export";
export type JobStatus = "queued" | "running" | "done" | "failed";
export interface JobProgress {
  steps?: Array<{ key: string; label: string; status: "waiting" | "running" | "done" | "failed"; reason?: string }>;
  message?: string;
}
export interface Job {
  id: string;
  orgId: string;
  projectId: string | null;
  kind: JobKind;
  status: JobStatus;
  input: Record<string, unknown>;
  result: unknown;
  error: string | null;
  errorStatus: number | null;
  progress: JobProgress;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface UmlRound {
  id: string;
  projectId: string;
  candidates: Array<{ label: string; providerId: string; model: UmlModel; dropped: number }>;
  evaluation: UmlComparison["evaluation"];
  failures: UmlComparison["failures"];
  warnings: string[];
  status: "awaiting_decision" | "decided";
  createdAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  roundId: string;
  pick: string;
  reason: string;
  mapping: Record<string, string>;
  createdAt: string;
}

export interface UsageRecord {
  orgId: string;
  providerId: string;
  projectId: string;
  inputTokens: number;
  outputTokens: number;
  at: string;
}

export interface UmlModelRecord {
  id: string;
  projectId: string;
  model: UmlModel;
  providerId: string;
  createdAt: string;
}

export type IntegrationKind = "github" | "jira" | "backlog";

/** 課題管理ツールとの接続。トークンは暗号化して保存し、画面やログには末尾4文字しか出さない */
export interface Integration {
  id: string;
  orgId: string;
  kind: IntegrationKind;
  label: string;
  /** 接続先（リポジトリ、URL、プロジェクトキーなど）。秘密情報は入れない */
  config: Record<string, string>;
  encryptedSecret: string;
  secretLast4: string;
  createdAt: string;
  updatedAt: string | null;
}
export type IntegrationPatch = Partial<Pick<Integration, "label" | "config" | "encryptedSecret" | "secretLast4">>;

export interface TaskPlanRecord {
  id: string;
  projectId: string;
  plan: TaskPlan;
  providerId: string;
  /** 分解に使った要件（コードと版）。要件がその後変わったかの判定に使う */
  basis: Array<{ code: string; version: number }>;
  createdBy: string;
  createdAt: string;
}

export interface ExportItem {
  /** E1 / E1-S2 */
  key: string;
  type: "epic" | "story";
  title: string;
  status: "created" | "skipped" | "failed";
  url?: string;
  /** 外部ツールでの番号（#12、PROJ-3 など） */
  externalKey?: string;
  /** 外部ツールの内部ID（Backlog の親課題指定などに使う） */
  externalId?: string;
  error?: string;
  /** 登録はできたが一部を省いたときの説明（ラベルや親子関係が使えなかった等） */
  note?: string;
}

export interface TaskExport {
  id: string;
  projectId: string;
  planId: string;
  integrationId: string;
  kind: IntegrationKind;
  /** 登録先の表示名（owner/repo、プロジェクトキーなど） */
  target: string;
  items: ExportItem[];
  createdBy: string;
  createdAt: string;
}

export interface Store {
  createOrg(name: string): Promise<Org>;
  getOrg(id: string): Promise<Org | null>;
  setOrgLimit(id: string, monthlyTokenLimit: number | null): Promise<Org | null>;

  addCredential(c: Omit<ProviderCredential, "id" | "createdAt" | "updatedAt">): Promise<ProviderCredential>;
  listCredentials(orgId: string): Promise<ProviderCredential[]>;
  updateCredential(orgId: string, id: string, patch: CredentialPatch): Promise<ProviderCredential | null>;
  deleteCredential(orgId: string, id: string): Promise<boolean>;

  createProject(p: Omit<Project, "id" | "createdAt" | "phaseKey">): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  setProjectPhase(id: string, phaseKey: string): Promise<void>;

  saveRound(r: Omit<Round, "id" | "createdAt">): Promise<Round>;
  getRound(id: string): Promise<Round | null>;
  markRoundDecided(id: string): Promise<void>;

  /** コード（FR-01 など）は区分ごとの連番で採番する */
  addRequirements(
    projectId: string,
    items: Array<RequirementItem & { roundId: string | null; source: string; phaseKey?: string | null }>,
  ): Promise<Requirement[]>;
  /** 削除済みを含まない */
  listRequirements(projectId: string): Promise<Requirement[]>;
  getRequirement(id: string): Promise<Requirement | null>;
  /** 変更前の内容を版として残し、version を1つ上げる */
  updateRequirement(id: string, patch: RequirementPatch, actor: string, reason: string): Promise<Requirement | null>;
  /** 論理削除。番号は再利用しない */
  deleteRequirement(id: string): Promise<boolean>;
  listRequirementVersions(id: string): Promise<RequirementVersion[]>;

  saveGuide(projectId: string, guide: Guide): Promise<void>;
  /** フェーズごとの最新ガイド */
  latestGuides(projectId: string): Promise<Guide[]>;

  addAudit(e: Omit<AuditEntry, "id" | "at">): Promise<void>;
  listAudit(orgId: string, q: { limit: number; before?: string; action?: string }): Promise<AuditEntry[]>;
  purgeAudit(before: Date): Promise<number>;

  createJob(j: Pick<Job, "orgId" | "projectId" | "kind" | "input" | "createdBy">): Promise<Job>;
  /** 待ち行列の先頭を1件取り出して実行中にする（同時に複数が取らない） */
  claimJob(): Promise<Job | null>;
  updateJobProgress(id: string, progress: JobProgress): Promise<void>;
  finishJob(id: string, r: { status: "done" | "failed"; result?: unknown; error?: string; errorStatus?: number }): Promise<void>;
  getJob(id: string): Promise<Job | null>;
  /** 一定時間以上「実行中」のまま止まったジョブを失敗にする */
  failStaleJobs(startedBefore: Date): Promise<number>;

  saveUmlRound(r: Omit<UmlRound, "id" | "createdAt" | "status">): Promise<UmlRound>;
  getUmlRound(id: string): Promise<UmlRound | null>;
  markUmlRoundDecided(id: string): Promise<void>;

  addDecision(d: Omit<Decision, "id" | "createdAt">): Promise<Decision>;
  listDecisions(projectId: string): Promise<Decision[]>;

  saveUmlModel(projectId: string, model: UmlModel, providerId: string): Promise<UmlModelRecord>;
  latestUmlModel(projectId: string): Promise<UmlModelRecord | null>;

  addIntegration(i: Omit<Integration, "id" | "createdAt" | "updatedAt">): Promise<Integration>;
  listIntegrations(orgId: string): Promise<Integration[]>;
  updateIntegration(orgId: string, id: string, patch: IntegrationPatch): Promise<Integration | null>;
  deleteIntegration(orgId: string, id: string): Promise<boolean>;

  saveTaskPlan(r: Omit<TaskPlanRecord, "id" | "createdAt">): Promise<TaskPlanRecord>;
  getTaskPlan(id: string): Promise<TaskPlanRecord | null>;
  latestTaskPlan(projectId: string): Promise<TaskPlanRecord | null>;
  saveTaskExport(e: Omit<TaskExport, "id" | "createdAt">): Promise<TaskExport>;
  /** 新しい順 */
  listTaskExports(planId: string): Promise<TaskExport[]>;

  addUsage(u: Omit<UsageRecord, "at">): Promise<void>;
  /** since 以降（省略時は全期間）の利用量をAIごとに集計する */
  usageSummary(orgId: string, since?: Date): Promise<UsageRow[]>;
}

export function usageOf(u: Usage): { inputTokens: number; outputTokens: number } {
  return { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
}

const now = () => new Date().toISOString();

/** 開発・テスト用。再起動でデータは消える */
export class MemoryStore implements Store {
  private orgs = new Map<string, Org>();
  private creds = new Map<string, ProviderCredential>();
  private projects = new Map<string, Project>();
  private rounds = new Map<string, Round>();
  private reqs: Requirement[] = [];
  private decisions: Decision[] = [];
  private usage: UsageRecord[] = [];
  private umls: UmlModelRecord[] = [];
  private versions: RequirementVersion[] = [];
  private guides: Array<{ projectId: string; guide: Guide; at: string }> = [];
  private audits: AuditEntry[] = [];
  private jobs = new Map<string, Job>();
  private umlRounds = new Map<string, UmlRound>();
  private integrations = new Map<string, Integration>();
  private plans: TaskPlanRecord[] = [];
  private exports: TaskExport[] = [];
  private seq = 0;

  async createOrg(name: string) {
    const o: Org = { id: randomUUID(), name, monthlyTokenLimit: null, createdAt: now() };
    this.orgs.set(o.id, o);
    return o;
  }
  async getOrg(id: string) {
    return this.orgs.get(id) ?? null;
  }
  async setOrgLimit(id: string, monthlyTokenLimit: number | null) {
    const o = this.orgs.get(id);
    if (!o) return null;
    o.monthlyTokenLimit = monthlyTokenLimit;
    return o;
  }
  async addCredential(c: Omit<ProviderCredential, "id" | "createdAt" | "updatedAt">) {
    const r: ProviderCredential = { ...c, id: randomUUID(), createdAt: now(), updatedAt: null };
    this.creds.set(r.id, r);
    return r;
  }
  async listCredentials(orgId: string) {
    return [...this.creds.values()].filter((c) => c.orgId === orgId);
  }
  async updateCredential(orgId: string, id: string, patch: CredentialPatch) {
    const c = this.creds.get(id);
    if (!c || c.orgId !== orgId) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    Object.assign(c, defined, { updatedAt: now() });
    return c;
  }
  async deleteCredential(orgId: string, id: string) {
    const c = this.creds.get(id);
    if (!c || c.orgId !== orgId) return false;
    return this.creds.delete(id);
  }
  async createProject(p: Omit<Project, "id" | "createdAt" | "phaseKey">) {
    const r: Project = { ...p, id: randomUUID(), phaseKey: "purpose", createdAt: now() };
    this.projects.set(r.id, r);
    return r;
  }
  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }
  async setProjectPhase(id: string, phaseKey: string) {
    const p = this.projects.get(id);
    if (p) p.phaseKey = phaseKey;
  }
  async saveRound(r: Omit<Round, "id" | "createdAt">) {
    const x = { ...r, id: randomUUID(), createdAt: now() };
    this.rounds.set(x.id, x);
    return x;
  }
  async getRound(id: string) {
    return this.rounds.get(id) ?? null;
  }
  async markRoundDecided(id: string) {
    const r = this.rounds.get(id);
    if (r) r.status = "decided";
  }
  async addRequirements(projectId: string, items: Array<RequirementItem & { roundId: string | null; source: string; phaseKey?: string | null }>) {
    const out: Requirement[] = [];
    for (const it of items) {
      const n = this.reqs.filter((r) => r.projectId === projectId && r.type === it.type).length + 1;
      const r: Requirement = {
        id: randomUUID(),
        projectId,
        code: `${it.type}-${String(n).padStart(2, "0")}`,
        type: it.type,
        title: it.title,
        description: it.description,
        priority: it.priority,
        roundId: it.roundId,
        phaseKey: it.phaseKey ?? null,
        source: it.source,
        version: 1,
        createdAt: now(),
        updatedAt: null,
        deletedAt: null,
      };
      this.reqs.push(r);
      out.push(r);
    }
    return out;
  }
  async listRequirements(projectId: string) {
    return this.reqs.filter((r) => r.projectId === projectId && !r.deletedAt);
  }
  async getRequirement(id: string) {
    return this.reqs.find((r) => r.id === id) ?? null;
  }
  async updateRequirement(id: string, patch: RequirementPatch, actor: string, reason: string) {
    const r = this.reqs.find((x) => x.id === id && !x.deletedAt);
    if (!r) return null;
    this.versions.push({
      requirementId: r.id,
      version: r.version,
      title: r.title,
      description: r.description,
      priority: r.priority,
      changedBy: actor,
      changeReason: reason,
      createdAt: now(),
    });
    Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    r.version += 1;
    r.updatedAt = now();
    return r;
  }
  async deleteRequirement(id: string) {
    const r = this.reqs.find((x) => x.id === id && !x.deletedAt);
    if (!r) return false;
    r.deletedAt = now();
    return true;
  }
  async listRequirementVersions(id: string) {
    return this.versions.filter((v) => v.requirementId === id).sort((a, b) => b.version - a.version);
  }
  async saveGuide(projectId: string, guide: Guide) {
    this.guides.push({ projectId, guide, at: now() });
  }
  async latestGuides(projectId: string) {
    const m = new Map<string, Guide>();
    for (const g of this.guides.filter((x) => x.projectId === projectId)) m.set(g.guide.phaseKey, g.guide);
    return [...m.values()];
  }
  async addAudit(e: Omit<AuditEntry, "id" | "at">) {
    this.audits.push({ ...e, id: String(++this.seq), at: now() });
  }
  async listAudit(orgId: string, q: { limit: number; before?: string; action?: string }) {
    return this.audits
      .filter((a) => a.orgId === orgId && (!q.before || Number(a.id) < Number(q.before)) && (!q.action || a.action.startsWith(q.action)))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, q.limit);
  }
  async purgeAudit(before: Date) {
    const n = this.audits.length;
    this.audits = this.audits.filter((a) => a.at >= before.toISOString());
    return n - this.audits.length;
  }
  async createJob(j: Pick<Job, "orgId" | "projectId" | "kind" | "input" | "createdBy">) {
    const job: Job = {
      ...j,
      id: randomUUID(),
      status: "queued",
      result: null,
      error: null,
      errorStatus: null,
      progress: {},
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }
  async claimJob() {
    const next = [...this.jobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = "running";
    next.startedAt = now();
    return { ...next };
  }
  async updateJobProgress(id: string, progress: JobProgress) {
    const j = this.jobs.get(id);
    if (j) j.progress = progress;
  }
  async finishJob(id: string, r: { status: "done" | "failed"; result?: unknown; error?: string; errorStatus?: number }) {
    const j = this.jobs.get(id);
    if (!j) return;
    Object.assign(j, { status: r.status, result: r.result ?? null, error: r.error ?? null, errorStatus: r.errorStatus ?? null, finishedAt: now() });
  }
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }
  async failStaleJobs(startedBefore: Date) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === "running" && j.startedAt && j.startedAt < startedBefore.toISOString()) {
        Object.assign(j, { status: "failed", error: "処理が時間内に終わりませんでした", errorStatus: 504, finishedAt: now() });
        n++;
      }
    }
    return n;
  }
  async saveUmlRound(r: Omit<UmlRound, "id" | "createdAt" | "status">) {
    const x: UmlRound = { ...r, id: randomUUID(), status: "awaiting_decision", createdAt: now() };
    this.umlRounds.set(x.id, x);
    return x;
  }
  async getUmlRound(id: string) {
    return this.umlRounds.get(id) ?? null;
  }
  async markUmlRoundDecided(id: string) {
    const r = this.umlRounds.get(id);
    if (r) r.status = "decided";
  }
  async addDecision(d: Omit<Decision, "id" | "createdAt">) {
    const x = { ...d, id: randomUUID(), createdAt: now() };
    this.decisions.push(x);
    return x;
  }
  async listDecisions(projectId: string) {
    return this.decisions.filter((d) => d.projectId === projectId);
  }
  async saveUmlModel(projectId: string, model: UmlModel, providerId: string) {
    const r = { id: randomUUID(), projectId, model, providerId, createdAt: now() };
    this.umls.push(r);
    return r;
  }
  async latestUmlModel(projectId: string) {
    return this.umls.filter((u) => u.projectId === projectId).at(-1) ?? null;
  }
  async addIntegration(i: Omit<Integration, "id" | "createdAt" | "updatedAt">) {
    const r: Integration = { ...i, id: randomUUID(), createdAt: now(), updatedAt: null };
    this.integrations.set(r.id, r);
    return { ...r };
  }
  async listIntegrations(orgId: string) {
    return [...this.integrations.values()].filter((x) => x.orgId === orgId).map((x) => ({ ...x }));
  }
  async updateIntegration(orgId: string, id: string, patch: IntegrationPatch) {
    const r = this.integrations.get(id);
    if (!r || r.orgId !== orgId) return null;
    Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: now() });
    return { ...r };
  }
  async deleteIntegration(orgId: string, id: string) {
    const r = this.integrations.get(id);
    if (!r || r.orgId !== orgId) return false;
    return this.integrations.delete(id);
  }
  async saveTaskPlan(r: Omit<TaskPlanRecord, "id" | "createdAt">) {
    const x: TaskPlanRecord = { ...r, id: randomUUID(), createdAt: now() };
    this.plans.push(x);
    return x;
  }
  async getTaskPlan(id: string) {
    return this.plans.find((x) => x.id === id) ?? null;
  }
  async latestTaskPlan(projectId: string) {
    return this.plans.filter((x) => x.projectId === projectId).at(-1) ?? null;
  }
  async saveTaskExport(e: Omit<TaskExport, "id" | "createdAt">) {
    const x: TaskExport = { ...e, id: randomUUID(), createdAt: now() };
    this.exports.push(x);
    return x;
  }
  async listTaskExports(planId: string) {
    return this.exports.filter((x) => x.planId === planId).reverse();
  }
  async addUsage(u: Omit<UsageRecord, "at">) {
    this.usage.push({ ...u, at: now() });
  }
  async usageSummary(orgId: string, since?: Date) {
    const m = new Map<string, UsageRow>();
    const from = since?.toISOString() ?? "";
    for (const u of this.usage.filter((x) => x.orgId === orgId && x.at >= from)) {
      const s = m.get(u.providerId) ?? { providerId: u.providerId, inputTokens: 0, outputTokens: 0, calls: 0 };
      s.inputTokens += u.inputTokens;
      s.outputTokens += u.outputTokens;
      s.calls += 1;
      m.set(u.providerId, s);
    }
    return [...m.values()];
  }
}
