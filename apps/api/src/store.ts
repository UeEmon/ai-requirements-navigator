import { randomUUID } from "node:crypto";
import type { CandidateContent, RequirementItem, RequirementType, ScoredEvaluation, UmlModel, Usage, Vendor } from "@arn/ai-core";

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
  source: string;
  version: number;
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
    items: Array<RequirementItem & { roundId: string | null; source: string }>,
  ): Promise<Requirement[]>;
  listRequirements(projectId: string): Promise<Requirement[]>;

  addDecision(d: Omit<Decision, "id" | "createdAt">): Promise<Decision>;
  listDecisions(projectId: string): Promise<Decision[]>;

  saveUmlModel(projectId: string, model: UmlModel, providerId: string): Promise<UmlModelRecord>;
  latestUmlModel(projectId: string): Promise<UmlModelRecord | null>;

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
  async addRequirements(projectId: string, items: Array<RequirementItem & { roundId: string | null; source: string }>) {
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
        source: it.source,
        version: 1,
        createdAt: now(),
      };
      this.reqs.push(r);
      out.push(r);
    }
    return out;
  }
  async listRequirements(projectId: string) {
    return this.reqs.filter((r) => r.projectId === projectId);
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
