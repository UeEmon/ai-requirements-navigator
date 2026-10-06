/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AIコーディングツール・テストツールとの連携（機能 F10）。
 *
 * - APIトークン: 組織の管理者が発行する。read（要件・設計・テストを読む）/ report（実装状況・テスト結果の報告と質問）
 *   と、使えるプロジェクトを決められる。トークンそのものは保存せず SHA-256 だけを持つ
 * - 外部連携 API（/api/v1）: CI・テスト管理ツールなど。テスト結果は JUnit XML か JSON で受け取る。定義は /api/v1/openapi.json
 * - MCP サーバー（/mcp、Streamable HTTP）: Claude Code・Cursor・GitHub Copilot などの AI コーディングツール
 * - リポジトリ用パッケージ（zip）: AGENTS.md・要件と設計の Markdown・Gherkin のテストシナリオ・MCP の接続設定
 * - Webhook: 確定版の作成・変更の決定・質問・実装状況・テスト結果を、署名つきで外部へ知らせる
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  buildDiagrams,
  IMPL_LABELS,
  RULE_KINDS,
  JUnitParseError,
  matchResults,
  NFR_ITEMS,
  NFR_VERIFY,
  parseJUnitXml,
  renderAgentsMd,
  requirementStatus,
  screenFlowDiagram,
  summarizeScreens,
  testCasesCsv,
  toGherkinFeatures,
  toTaskMarkdown,
  type FetchLike,
  type ImplStatus,
  type RawTestResult,
  type Table,
} from "@arn/ai-core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Authenticator, Principal } from "./auth.js";
import type { KeyEncryptor } from "./crypto.js";
import type { handoff as handoffModule } from "./handoff.js";
import type { ImplementationContext } from "./implementation.js";
import { openApiDocument } from "./openapi.js";
import { WEBHOOK_EVENTS, type ApiToken, type Project, type TokenScope, type Webhook } from "./store.js";
import { zipFiles } from "./zip.js";

type AnyContext = Context<any>;
type Handoff = ReturnType<typeof handoffModule>;

export const TOKEN_PREFIX = "arn_";
export const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "requirements-navigator", title: "要件ナビ", version: "0.1.0" };

export interface ConnectOptions {
  authenticate: Authenticator;
  encryptor: KeyEncryptor;
  /** パッケージや AGENTS.md に書く、このサーバーの外から見たURL（PUBLIC_URL）。省略時はリクエストから作る */
  publicUrl?: string;
  /** Webhook の送り先に社内（プライベート）アドレスや http を許す（ローカルの Docker 向け） */
  allowPrivateWebhooks?: boolean;
  /** 名前解決（テスト用に差し替える） */
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
  fetchImpl?: FetchLike;
  /** 用語集・受け入れ基準・承認・確定版の差分（scope.ts） */
  scope?: () => {
    glossary: (p: Project) => Promise<unknown>;
    acceptance: (p: Project) => Promise<unknown>;
    approval: (p: Project) => Promise<unknown>;
    diff: (p: Project, from?: number, to?: number) => Promise<unknown>;
  };
}

/* ------------------------------------------------------------------ */
/* 入力の形                                                             */
/* ------------------------------------------------------------------ */

const ScopeSchema = z.enum(["read", "report"]);
const TokenInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ScopeSchema).min(1).default(["read"]),
  /** 使えるプロジェクト。省略時は組織のすべて */
  projectIds: z.array(z.string().min(1)).max(100).nullable().default(null),
  /** 有効期限（日数）。1〜365、既定 90 */
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
const WebhookInput = z.object({
  url: z.string().url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).default([...WEBHOOK_EVENTS]),
});
const ImplInput = z.object({
  items: z
    .array(
      z.object({
        requirementCode: z.string().min(1).max(20),
        status: z.enum(["not_started", "in_progress", "implemented", "blocked"]),
        refs: z.array(z.object({ label: z.string().min(1).max(100), url: z.string().url().max(500) })).max(10).default([]),
        note: z.string().max(1000).default(""),
      }),
    )
    .min(1)
    .max(500),
});
const TestRunInput = z.object({
  tool: z.string().max(60).default(""),
  revision: z.string().max(100).default(""),
  url: z.string().max(500).default(""),
  results: z
    .array(
      z.object({
        testId: z.string().max(60).optional(),
        name: z.string().max(500).optional(),
        status: z.enum(["passed", "failed", "skipped"]),
        message: z.string().max(2000).optional(),
        durationMs: z.number().min(0).optional(),
      }),
    )
    .max(20000)
    .optional(),
  /** JSON の中に JUnit XML を入れて送る場合（MCP から） */
  junitXml: z.string().max(10 * 1024 * 1024).optional(),
});
const QuestionInput = z.object({
  text: z.string().min(1).max(2000),
  requirementCode: z.string().max(20).nullable().optional(),
  context: z.string().max(4000).default(""),
});
const AnswerInput = z.object({
  answer: z.string().min(1).max(4000),
  /** answered: 回答した / closed: 回答せず閉じた（質問が不要になった など） */
  status: z.enum(["answered", "closed"]).default("answered"),
});

/* ------------------------------------------------------------------ */
/* Webhook の送り先の確認（SSRF 対策）                                  */
/* ------------------------------------------------------------------ */

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 本体                                                                 */
/* ------------------------------------------------------------------ */

export function connect(ctx: ImplementationContext, ho: Handoff, opts: ConnectOptions) {
  const { store } = ctx;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ctx.fetchImpl;
  const lookup = opts.lookup ?? (async (host: string) => dnsLookup(host, { all: true }));
  const pending = new Set<Promise<void>>();

  const tokenOf = (c: AnyContext): ApiToken | undefined => c.get("token");
  /** 外から見たURL。PUBLIC_URL がなければリクエストから作る（ロードバランサーで HTTPS を終端していれば X-Forwarded-Proto を使う） */
  const serverUrl = (c: AnyContext) => {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    const u = new URL(c.req.url);
    const proto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim();
    if (proto === "https" || proto === "http") u.protocol = `${proto}:`;
    return u.origin;
  };
  const publicToken = (t: ApiToken) => ({
    id: t.id,
    name: t.name,
    token: `${TOKEN_PREFIX}…${t.last4}`,
    scopes: t.scopes,
    projectIds: t.projectIds,
    expiresAt: t.expiresAt,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  });
  const publicWebhook = (w: Webhook) => ({ id: w.id, url: w.url, events: w.events, lastStatus: w.lastStatus, lastAt: w.lastAt, createdBy: w.createdBy, createdAt: w.createdAt });

  /* ---------- 認証（トークン、または画面のログイン） ---------- */

  const tokenAuth: MiddlewareHandler<any> = async (c, next) => {
    if (c.req.path === "/api/v1/openapi.json") return next();
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(arn_[A-Za-z0-9_-]{20,100})\s*$/.exec(h);
    if (m) {
      const t = await store.findApiToken(hashToken(m[1]!));
      if (!t || t.revokedAt || (t.expiresAt && t.expiresAt < new Date().toISOString())) {
        return c.json({ error: "トークンが無効か、期限切れです" }, 401, { "WWW-Authenticate": 'Bearer realm="requirements-navigator", error="invalid_token"' });
      }
      const p: Principal = { userId: `token:${t.name}`, orgId: t.orgId, role: "viewer" };
      c.set("principal", p);
      c.set("token", t);
      void store.touchApiToken(t.id).catch(() => undefined);
      return next();
    }
    const p = await opts.authenticate(c.req.raw);
    if (!p) return c.json({ error: "トークン（Authorization: Bearer arn_…）が必要です" }, 401, { "WWW-Authenticate": 'Bearer realm="requirements-navigator"' });
    c.set("principal", p);
    return next();
  };

  /** プロジェクトを読み込み、トークンの範囲・権限、または利用者の役割を確かめる */
  async function projectFor(c: AnyContext, id: string | undefined, need: TokenScope): Promise<Project> {
    const t = tokenOf(c);
    if (!id) {
      // トークンが1つのプロジェクトに限られていれば省略できる
      if (t?.projectIds?.length === 1) id = t.projectIds[0]!;
      else {
        const ps = await accessibleProjects(c);
        if (ps.length === 1) id = ps[0]!.id;
        else throw new HTTPException(400, { message: "projectId を指定してください（list_projects・GET /api/v1/projects で確認できます）" });
      }
    }
    if (!t) return ctx.loadProject(c, id, need === "read" ? "project.view" : "requirements.edit");
    const p = await store.getProject(id);
    if (!p || p.orgId !== t.orgId || (t.projectIds && !t.projectIds.includes(p.id))) throw new HTTPException(404, { message: "プロジェクトが見つかりません" });
    if (!t.scopes.includes(need)) throw new HTTPException(403, { message: `このトークンには ${need} の権限がありません` });
    return p;
  }

  async function accessibleProjects(c: AnyContext): Promise<Project[]> {
    const pr = c.get("principal") as Principal;
    const t = tokenOf(c);
    const all = await store.listProjects(pr.orgId);
    return t?.projectIds ? all.filter((p) => t.projectIds!.includes(p.id)) : all;
  }

  /* ---------- 読む ---------- */

  async function overview(p: Project) {
    const reqs = await store.listRequirements(p.id);
    const counts: Record<string, number> = {};
    for (const r of reqs) counts[r.type] = (counts[r.type] ?? 0) + 1;
    const baseline = await store.latestBaseline(p.id);
    const r = await ho.readiness(p);
    const st = await status(p);
    return {
      id: p.id,
      name: p.name,
      purpose: p.purpose,
      baseline: baseline ? { version: baseline.version, createdAt: baseline.createdAt } : null,
      counts,
      readiness: { verdict: r.verdict, score: r.score, openQuestions: r.openQuestions },
      status: st.summary,
    };
  }

  async function requirementsOf(p: Project, q: { type?: string; codes?: string[] }) {
    const t = await ho.tests(p);
    const keyOf = new Map(t.treqs.map((r) => [r.code, r.nfrKey ?? null]));
    return t.reqs
      .filter((r) => (!q.type || r.type === q.type) && (!q.codes?.length || q.codes.includes(r.code)))
      .map((r) => ({ code: r.code, type: r.type, title: r.title, description: r.description, priority: r.priority, ears: r.ears, rule: r.rule ?? null, version: r.version, nfrKey: keyOf.get(r.code) ?? null }));
  }

  async function requirementDetail(p: Project, code: string) {
    const t = await ho.tests(p);
    const r = t.reqs.find((x) => x.code === code);
    if (!r) throw new HTTPException(404, { message: `要件 ${code} が見つかりません` });
    const d = await ho.designTables(p);
    const screens = await store.latestScreens(p.id);
    const st = (await status(p)).rows.find((x) => x.code === code) ?? null;
    const nfrKey = t.treqs.find((x) => x.code === code)?.nfrKey;
    const item = nfrKey ? NFR_ITEMS.find((i) => i.key === nfrKey) : undefined;
    return {
      code: r.code,
      type: r.type,
      title: r.title,
      description: r.description,
      priority: r.priority,
      ears: r.ears,
      rule: r.rule ?? null,
      version: r.version,
      source: r.source,
      nfr: item ? { key: item.key, name: item.name, verification: NFR_VERIFY[item.key] ?? null } : null,
      tests: t.cases.filter((c) => c.requirementCode === code || (c.storyKey && t.stories.some((s) => s.key === c.storyKey && s.requirementCodes.includes(code)))),
      stories: t.stories.filter((s) => s.requirementCodes.includes(code)),
      screens: (screens?.model.screens ?? []).filter((s) => s.requirementCodes.includes(code)).map((s) => ({ key: s.key, name: s.name, purpose: s.purpose, elements: s.elements })),
      screenItems: d.screenItems.rows.filter((r) => (screens?.model.screens ?? []).some((s) => s.requirementCodes.includes(code) && r[0] === `${s.key} ${s.name}`)),
      entities: (d.model?.classes ?? []).filter((c) => (c.requirementCodes ?? []).includes(code)),
      interfaces: (d.model?.interfaces ?? []).filter((i) => (i.requirementCodes ?? []).includes(code)),
      status: st ? { implementation: st.impl, tests: st.tests } : null,
      questions: (await store.listQuestions(p.id)).filter((q) => q.requirementCode === code),
    };
  }

  async function designOf(p: Project, part?: string) {
    const d = await ho.designTables(p);
    const screens = await store.latestScreens(p.id);
    const all = {
      entities: d.entities,
      data: d.data,
      crud: d.crud,
      interfaces: d.interfaces,
      states: d.states,
      outputs: d.outputs,
      batches: d.batches,
      screenItems: d.screenItems,
      model: d.model,
      screens: screens?.model ?? null,
    };
    if (!part) return all;
    if (!(part in all)) throw new HTTPException(400, { message: `part は ${Object.keys(all).join(" / ")} のいずれかです` });
    return { [part]: all[part as keyof typeof all] };
  }

  async function testCasesOf(p: Project, q: { requirementCode?: string; level?: string }) {
    const t = await ho.tests(p);
    return {
      cases: t.cases.filter((c) => (!q.requirementCode || c.requirementCode === q.requirementCode) && (!q.level || c.level === q.level)),
      coverage: t.trace.coverage,
      naming: "テスト名にテストID（例: TC-FR-01-1）を含めると、結果が要件に結びつきます",
    };
  }

  async function status(p: Project) {
    const t = await ho.tests(p);
    const runs = await store.listTestRuns(p.id, 200);
    return requirementStatus(
      t.reqs.map((r) => ({ code: r.code, type: r.type, title: r.title, version: r.version })),
      t.cases,
      await store.listImplReports(p.id),
      runs.map((r) => ({ id: r.id, at: r.createdAt, tests: r.tests, requirements: r.requirements })),
    );
  }

  const needScope = () => {
    const sc = opts.scope?.();
    if (!sc) throw new HTTPException(501, { message: "この機能は使えません" });
    return sc;
  };

  /* ---------- 報告する ---------- */

  async function reportImplementation(c: AnyContext, p: Project, input: z.infer<typeof ImplInput>) {
    const reqs = new Map((await store.listRequirements(p.id)).map((r) => [r.code, r]));
    const unknown = input.items.filter((i) => !reqs.has(i.requirementCode)).map((i) => i.requirementCode);
    if (unknown.length) throw new HTTPException(400, { message: `存在しない要件です: ${[...new Set(unknown)].join(", ")}` });
    const actor = ctx.actorOf(c);
    const at = new Date().toISOString();
    const saved = await store.addImplReports(
      p.id,
      input.items.map((i) => ({ requirementCode: i.requirementCode, status: i.status as ImplStatus, requirementVersion: reqs.get(i.requirementCode)!.version, refs: i.refs, note: i.note, reportedBy: actor, at })),
    );
    await audit(store, { orgId: p.orgId, actor, action: "impl.report", targetType: "project", targetId: p.id, detail: { items: saved.map((s) => `${s.requirementCode}:${s.status}`) } });
    emit(p.orgId, "implementation.reported", { projectId: p.id, items: saved.map((s) => ({ requirementCode: s.requirementCode, status: s.status, refs: s.refs })) });
    return { recorded: saved.length, items: saved.map((s) => ({ requirementCode: s.requirementCode, status: s.status, statusLabel: IMPL_LABELS[s.status], requirementVersion: s.requirementVersion })) };
  }

  async function recordTestRun(c: AnyContext, p: Project, input: { tool: string; revision: string; url: string; format: "junit" | "json"; results: RawTestResult[] }) {
    if (!input.results.length) throw new HTTPException(400, { message: "テスト結果がありません" });
    const t = await ho.tests(p);
    const m = matchResults(input.results, t.cases.map((x) => x.id), t.reqs.map((r) => r.code));
    const count = (s: string) => m.tests.filter((x) => x.status === s).length + m.requirements.filter((x) => x.status === s).length;
    const summary = { passed: count("passed"), failed: count("failed"), skipped: count("skipped"), unmatched: m.unmatched.length };
    const actor = ctx.actorOf(c);
    const run = await store.addTestRun({ projectId: p.id, tool: input.tool, revision: input.revision, url: /^https?:\/\//.test(input.url) ? input.url : "", format: input.format, ...m, unmatched: m.unmatched.slice(0, 200), summary, createdBy: actor });
    await audit(store, { orgId: p.orgId, actor, action: "test_run.record", targetType: "project", targetId: p.id, detail: { runId: run.id, tool: run.tool, revision: run.revision, ...summary } });
    emit(p.orgId, "test_run.recorded", { projectId: p.id, runId: run.id, tool: run.tool, revision: run.revision, summary, failed: m.tests.filter((x) => x.status === "failed").map((x) => x.testId) });
    return {
      id: run.id,
      summary,
      matched: m.tests.length + m.requirements.length,
      unmatched: m.unmatched.slice(0, 50),
      hint: m.unmatched.length ? "結びつかなかったテストは、名前にテストID（TC-FR-01-1 など）か要件ID（FR-01 など）を含めてください" : undefined,
    };
  }

  async function ask(c: AnyContext, p: Project, input: z.infer<typeof QuestionInput>) {
    if (input.requirementCode && !(await store.listRequirements(p.id)).some((r) => r.code === input.requirementCode)) {
      throw new HTTPException(400, { message: `存在しない要件です: ${input.requirementCode}` });
    }
    const actor = ctx.actorOf(c);
    const q = await store.addQuestion({ projectId: p.id, requirementCode: input.requirementCode ?? null, text: input.text, context: input.context, askedBy: actor });
    await audit(store, { orgId: p.orgId, actor, action: "question.create", targetType: "project", targetId: p.id, detail: { code: q.code, requirementCode: q.requirementCode } });
    emit(p.orgId, "question.created", { projectId: p.id, code: q.code, requirementCode: q.requirementCode, text: q.text });
    return { id: q.id, code: q.code, status: q.status, message: "質問を登録しました。回答は list_questions（GET /questions）で確認できます" };
  }

  /* ---------- リポジトリ用パッケージ ---------- */

  const mdTable = (t: Table) => (t.rows.length ? [`| ${t.head.join(" | ")} |`, `| ${t.head.map(() => "---").join(" | ")} |`, ...t.rows.map((r) => `| ${r.map((x) => (x || " ").replace(/\|/g, "\\|")).join(" | ")} |`)].join("\n") : "（まだありません）");

  /** 開発用パッケージ（リポジトリに置くファイル）。AGENTS.md を先頭にした一覧 */
  async function agentFiles(c: AnyContext, p: Project): Promise<Array<{ path: string; content: string }>> {
    const url = serverUrl(c);
    const b = await ho.bundle(p);
    const t = await ho.tests(p);
    const d = await ho.designTables(p);
    const screens = await store.latestScreens(p.id);
    const plan = await store.latestTaskPlan(p.id);
    const counts: Record<string, number> = {};
    for (const r of t.reqs) counts[r.type] = (counts[r.type] ?? 0) + 1;
    const TYPES: Array<[string, string]> = [["BR", "目的"], ["AC", "利用者"], ["FR", "機能要件"], ["RL", "業務ルール"], ["NFR", "非機能要件"], ["CN", "制約"]];
    const reqMd = [
      `# ${p.name} 要件一覧`,
      "",
      `要件ナビが ${new Date().toISOString().slice(0, 10)} に出力（${b.baseline ? `確定版 第${b.baseline.version}版` : "確定版なし"}）。要件文は EARS 記法です。`,
      "",
      ...TYPES.flatMap(([type, label]) => {
        const rows = b.requirements.filter((r) => r.type === type);
        if (!rows.length) return [];
        const esc = (x: string) => x.replace(/\|/g, "\\|");
        const examples = (r: (typeof rows)[number]) => (r.rule?.examples ?? []).map((e) => `${esc(e.given)} → ${esc(e.expected)}`).join("<br>");
        return type === "RL"
          ? [`## ${label}`, "", "| ID | ルール | 種類 | 具体例（条件 → 結果） | 版 | テスト |", "| --- | --- | --- | --- | --- | --- |", ...rows.map((r) => `| ${r.code} | ${esc(r.title)} | ${r.rule ? RULE_KINDS[r.rule.kind] : ""} | ${examples(r)} | ${r.version} | ${t.cases.filter((x) => x.requirementCode === r.code).map((x) => x.id).join(", ")} |`), ""]
          : [`## ${label}`, "", "| ID | 要件 | 優先度 | 版 | テスト |", "| --- | --- | --- | --- | --- |", ...rows.map((r) => `| ${r.code} | ${esc(r.title)} | ${r.priority} | ${r.version} | ${t.cases.filter((x) => x.requirementCode === r.code).map((x) => x.id).join(", ")} |`), ""];
      }),
      "## 非機能要件シート（確認方法）",
      "",
      ...b.nfr.items.filter((i) => i.status === "decided").map((i) => `- ${i.name}：${i.levelLabel ?? i.value}${i.verification ? `（確認方法：${i.verification.method}）` : ""}`),
      "",
      "## 受け入れ基準",
      "",
      ...((b.acceptance?.evaluation.items ?? []) as Array<{ label: string; target: string }>).map((i) => `- ${i.label}：${i.target}`),
      "",
    ].join("\n");
    const glossaryMd = [
      `# ${p.name} 用語集`,
      "",
      "要件・コード・テストではこの用語を使い、「言い換え」の言葉は使わないでください。",
      "",
      "| 用語 | 意味 | 言い換え（使わない） | コード上の名前 |",
      "| --- | --- | --- | --- |",
      ...((b.glossary ?? []) as Array<{ term: string; definition: string; synonyms: string[]; codeName: string }>).map((g) => `| ${g.term} | ${g.definition.replace(/\|/g, "\\|")} | ${g.synonyms.join("、")} | ${g.codeName} |`),
      "",
    ].join("\n");
    const diagrams = [...buildDiagrams(p.name, t.reqs.map((r) => ({ code: r.code, type: r.type, title: r.title })), d.model), ...(screens ? [screenFlowDiagram(screens.model)] : [])];
    const designMd = [
      `# ${p.name} 設計の材料`,
      "",
      "要件定義の段階の論理モデルです。物理設計（テーブル定義・API仕様）はこれを元に決めてください。「コード上の名前」は実装でもそのまま使ってください。",
      "",
      "## エンティティ",
      "",
      mdTable(d.entities),
      "",
      "## データ項目定義",
      "",
      mdTable(d.data),
      "",
      "## 権限表",
      "",
      d.crud.caption ?? "",
      "",
      mdTable(d.crud),
      "",
      "## 外部とのやり取り",
      "",
      mdTable(d.interfaces),
      "",
      "## 画面の入出力項目",
      "",
      "入力チェックは、データ項目定義の「必須」「業務上の制約」「区分値」を満たすようにしてください。",
      "",
      mdTable(d.screenItems),
      "",
      "## 状態が変わる条件",
      "",
      mdTable(d.states),
      "",
      "## 帳票・出力",
      "",
      mdTable(d.outputs),
      "",
      "## まとめて行う処理（バッチ）",
      "",
      mdTable(d.batches),
      "",
      "## 図",
      "",
      ...diagrams.flatMap((g) => [`### ${g.title}`, "", "```mermaid", g.mermaid, "```", ""]),
    ].join("\n");
    const features = toGherkinFeatures(t.reqs.map((r) => ({ code: r.code, type: r.type, title: r.title, version: r.version })), t.cases, t.stories);
    const mcpJson = JSON.stringify({ mcpServers: { "requirements-navigator": { type: "http", url: `${url}/mcp`, headers: { Authorization: "Bearer ${ARN_TOKEN}" } } } }, null, 2);
    const reportSh = `#!/bin/sh
# テスト結果（JUnit XML）を要件ナビに送る。
# 使い方: ARN_TOKEN=arn_... sh scripts/report-test-results.sh <junit.xml> [ツール名]
set -eu
FILE="\${1:?JUnit XML のファイルを指定してください}"
TOOL="\${2:-unknown}"
REV="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
curl -fsS -X POST "${url}/api/v1/projects/${p.id}/test-runs?tool=$TOOL&revision=$REV" \\
  -H "Authorization: Bearer \${ARN_TOKEN:?環境変数 ARN_TOKEN にトークンを入れてください}" \\
  -H "Content-Type: application/xml" \\
  --data-binary "@$FILE"
echo
`;
    const files: Array<{ path: string; content: string }> = [
      { path: "CLAUDE.md", content: "@AGENTS.md\n" },
      { path: ".mcp.json", content: `${mcpJson}\n` },
      { path: "requirements/requirements.md", content: reqMd },
      { path: "requirements/design.md", content: designMd },
      { path: "requirements/glossary.md", content: glossaryMd },
      ...(screens ? [{ path: "requirements/screens.md", content: `# ${p.name} 画面一覧\n\n見た目（色・配置・文言）は設計工程で決めます。\n\n${summarizeScreens(screens.model)}\n` }] : []),
      ...(plan ? [{ path: "requirements/tasks.md", content: toTaskMarkdown(plan.plan, p.name, t.reqs.map((r) => ({ code: r.code, type: r.type, title: r.title }))) }] : []),
      { path: "requirements/handoff.json", content: JSON.stringify(b, null, 2) },
      ...features,
      { path: "tests/testcases.csv", content: testCasesCsv(t.cases) },
      { path: "scripts/report-test-results.sh", content: reportSh },
      { path: ".arn/project.json", content: `${JSON.stringify({ server: url, projectId: p.id, projectName: p.name, baselineVersion: b.baseline?.version ?? null, generatedAt: b.generatedAt }, null, 2)}\n` },
    ];
    const nfr = b.nfr.items.filter((i) => i.status === "decided" && (i.levelLabel || i.value)).slice(0, 12).map((i) => `${i.name}：${i.levelLabel ?? i.value}`);
    const agents = renderAgentsMd({
      projectName: p.name,
      purpose: p.purpose,
      projectId: p.id,
      serverUrl: url,
      baseline: b.baseline,
      counts,
      verdict: { ready: "引き渡せる", conditional: "確認事項を共有すれば着手できる", "not-ready": "足りないものがある" }[b.readiness.verdict],
      openQuestions: b.readiness.openQuestions,
      nfr,
      files: ["AGENTS.md", ...files.map((f) => f.path).filter((f) => !f.startsWith("tests/acceptance/")), `tests/acceptance/*.feature（${features.length}ファイル）`],
    });
    return [{ path: "AGENTS.md", content: agents }, ...files];
  }

  async function agentPack(c: AnyContext, p: Project) {
    const files = await agentFiles(c, p);
    const zip = zipFiles(files);
    await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "handoff.pack", targetType: "project", targetId: p.id, detail: { files: files.length, bytes: zip.length } });
    return zip;
  }

  /* ---------- Webhook ---------- */

  async function checkWebhookTarget(raw: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new HTTPException(400, { message: "URLが正しくありません" });
    }
    if (u.username || u.password) throw new HTTPException(400, { message: "URLに利用者名・パスワードを含めないでください" });
    if (u.protocol !== "https:" && !(u.protocol === "http:" && opts.allowPrivateWebhooks)) throw new HTTPException(400, { message: "https:// のURLを指定してください" });
    if (!opts.allowPrivateWebhooks) {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      let addrs: Array<{ address: string }>;
      try {
        addrs = isIP(host) ? [{ address: host }] : await lookup(host);
      } catch {
        throw new HTTPException(400, { message: `送り先の名前を解決できません: ${host}` });
      }
      if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
        throw new HTTPException(400, { message: "社内（プライベート）アドレスには送れません。ローカルで使う場合は WEBHOOK_ALLOW_PRIVATE=true にしてください" });
      }
    }
    return u;
  }

  async function deliver(w: Webhook, event: string, payload: Record<string, unknown>): Promise<string> {
    let status: string;
    try {
      await checkWebhookTarget(w.url); // 名前解決の結果が変わっていないかを送るたびに確かめる
      const secret = await opts.encryptor.decrypt(w.encryptedSecret, { orgId: w.orgId });
      const id = randomUUID();
      const ts = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ id, event, at: new Date().toISOString(), orgId: w.orgId, data: payload });
      const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetchImpl(w.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "requirements-navigator-webhook", "x-arn-event": event, "x-arn-delivery": id, "x-arn-timestamp": ts, "x-arn-signature": `sha256=${sig}` },
          body,
          signal: ctrl.signal,
          redirect: "manual",
        } as any);
        status = `HTTP ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      status = `失敗: ${e instanceof HTTPException ? e.message : (e as Error).name === "AbortError" ? "10秒以内に応答がありません" : (e as Error).message}`.slice(0, 200);
    }
    await store.recordWebhookDelivery(w.id, status).catch(() => undefined);
    return status;
  }

  /** 登録された Webhook に知らせる（処理は待たない。失敗は送り先の状態に残す） */
  function emit(orgId: string, event: string, data: Record<string, unknown>) {
    const job = (async () => {
      const hooks = (await store.listWebhooks(orgId)).filter((w) => (w.events as string[]).includes(event));
      await Promise.all(hooks.map((w) => deliver(w, event, data)));
    })().catch((e) => console.error("webhook", e));
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }

  /* ---------- MCP ---------- */

  const str = { type: "string" } as const;
  const pid = { projectId: { type: "string", description: "プロジェクトID。トークンが1つのプロジェクトに限られていれば省略できます" } };
  const TOOLS: Array<{ name: string; title: string; description: string; inputSchema: Record<string, unknown>; scope: TokenScope; run: (c: AnyContext, a: any) => Promise<Record<string, unknown>> }> = [
    {
      name: "list_projects",
      title: "プロジェクトの一覧",
      description: "このトークンで使えるプロジェクトの一覧（ID・名前・目的・確定版）",
      inputSchema: { type: "object", properties: {} },
      scope: "read",
      run: async (c) => ({
        projects: await Promise.all(
          (await accessibleProjects(c)).map(async (p) => ({ id: p.id, name: p.name, purpose: p.purpose, baselineVersion: (await store.latestBaseline(p.id))?.version ?? null })),
        ),
      }),
    },
    {
      name: "get_project_overview",
      title: "プロジェクトの概要",
      description: "目的・要件の件数・確定版・着手前チェックの判定と未決事項・実装とテストの集計。作業を始める前に読んでください",
      inputSchema: { type: "object", properties: { ...pid } },
      scope: "read",
      run: async (c, a) => overview(await projectFor(c, a.projectId, "read")),
    },
    {
      name: "list_requirements",
      title: "要件の一覧",
      description: "要件の一覧。title は要件文（機能・非機能は EARS 記法で、ears にその構造）。業務ルール（RL）は rule に種類と具体例（条件 → 結果）。type で絞り込めます（BR 目的 / AC 利用者 / FR 機能 / RL 業務ルール / NFR 非機能 / CN 制約）",
      inputSchema: { type: "object", properties: { ...pid, type: { type: "string", enum: ["BR", "AC", "FR", "RL", "NFR", "CN"] }, codes: { type: "array", items: str, description: "要件ID（FR-01 など）" } } },
      scope: "read",
      run: async (c, a) => ({ requirements: await requirementsOf(await projectFor(c, a.projectId, "read"), { type: a.type, codes: a.codes }) }),
    },
    {
      name: "get_requirement",
      title: "要件の詳細",
      description: "1つの要件について、テストケース・ストーリー（受け入れ条件）・画面・エンティティ・外部とのやり取り・実装とテストの状況・質問をまとめて返します。実装を始める前に読んでください",
      inputSchema: { type: "object", properties: { ...pid, code: { type: "string", description: "要件ID（FR-01 など）" } }, required: ["code"] },
      scope: "read",
      run: async (c, a) => requirementDetail(await projectFor(c, a.projectId, "read"), String(a.code ?? "")),
    },
    {
      name: "get_design",
      title: "設計の材料",
      description: "データ項目定義（コード上の名前・型・キー・必須・業務上の制約・区分値）、権限表（CRUD）、外部とのやり取り、状態が変わる条件、帳票・出力、まとめて行う処理、画面の入出力項目、設計モデル、画面一覧。part で一部だけ取れます",
      inputSchema: { type: "object", properties: { ...pid, part: { type: "string", enum: ["entities", "data", "crud", "interfaces", "states", "outputs", "batches", "screenItems", "model", "screens"] } } },
      scope: "read",
      run: async (c, a) => designOf(await projectFor(c, a.projectId, "read"), a.part),
    },
    {
      name: "get_test_cases",
      title: "テストケース",
      description: "要件から作ったテストケース（前提・操作・期待する結果）。テスト名にテストID（TC-FR-01-1 など）を含めると、結果が要件に結びつきます",
      inputSchema: { type: "object", properties: { ...pid, requirementCode: str, level: { type: "string", enum: ["system", "nfr", "acceptance"] } } },
      scope: "read",
      run: async (c, a) => testCasesOf(await projectFor(c, a.projectId, "read"), { requirementCode: a.requirementCode, level: a.level }),
    },
    {
      name: "get_status",
      title: "実装とテストの状況",
      description: "要件ごとの実装状況（報告の最新）とテスト結果（合格・不合格・未実施）。要件が報告後に変わったものは stale が true",
      inputSchema: { type: "object", properties: { ...pid } },
      scope: "read",
      run: async (c, a) => status(await projectFor(c, a.projectId, "read")),
    },
    {
      name: "list_questions",
      title: "質問と回答",
      description: "要件ナビに出した質問と、その回答",
      inputSchema: { type: "object", properties: { ...pid, status: { type: "string", enum: ["open", "answered", "closed"] } } },
      scope: "read",
      run: async (c, a) => ({ questions: (await store.listQuestions((await projectFor(c, a.projectId, "read")).id)).filter((q) => !a.status || q.status === a.status) }),
    },
    {
      name: "get_glossary",
      title: "用語集",
      description: "業務の言葉の意味・言い換え（使わない）・コード上の名前。名前を付けるときはこの用語を使ってください",
      inputSchema: { type: "object", properties: { ...pid } },
      scope: "read",
      run: async (c, a) => needScope().glossary(await projectFor(c, a.projectId, "read")) as Promise<Record<string, unknown>>,
    },
    {
      name: "get_acceptance",
      title: "受け入れ基準",
      description: "何を満たせば受け入れられるか（合格率・不合格の上限・確認すること）と、いまのテスト結果に照らした判定",
      inputSchema: { type: "object", properties: { ...pid } },
      scope: "read",
      run: async (c, a) => needScope().acceptance(await projectFor(c, a.projectId, "read")) as Promise<Record<string, unknown>>,
    },
    {
      name: "get_changes",
      title: "確定版からの変更",
      description: "指定した確定版（sinceVersion。省略時は最新の確定版）から、いま（または toVersion）までに追加・変更・削除された要件と、影響するテスト・ストーリー・画面",
      inputSchema: { type: "object", properties: { ...pid, sinceVersion: { type: "integer", minimum: 1 }, toVersion: { type: "integer", minimum: 1 } } },
      scope: "read",
      run: async (c, a) => needScope().diff(await projectFor(c, a.projectId, "read"), a.sinceVersion ? Number(a.sinceVersion) : undefined, a.toVersion ? Number(a.toVersion) : undefined) as Promise<Record<string, unknown>>,
    },
    {
      name: "report_implementation",
      title: "実装状況の報告",
      description: "要件ごとの実装状況を報告します（not_started / in_progress / implemented / blocked）。refs にプルリクエストやコミットのURLを付けてください",
      inputSchema: {
        type: "object",
        properties: {
          ...pid,
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                requirementCode: str,
                status: { type: "string", enum: ["not_started", "in_progress", "implemented", "blocked"] },
                refs: { type: "array", items: { type: "object", properties: { label: str, url: str }, required: ["label", "url"] } },
                note: str,
              },
              required: ["requirementCode", "status"],
            },
          },
        },
        required: ["items"],
      },
      scope: "report",
      run: async (c, a) => reportImplementation(c, await projectFor(c, a.projectId, "report"), ctx.parseOrThrow(ImplInput, a)),
    },
    {
      name: "report_test_results",
      title: "テスト結果の報告",
      description: "テストの実行結果を報告します。results（testId か name と status）か、junitXml（JUnit XML の本文）のどちらかを渡してください",
      inputSchema: {
        type: "object",
        properties: {
          ...pid,
          tool: str,
          revision: { type: "string", description: "コミットやビルドの番号" },
          url: { type: "string", description: "CIの実行結果のURL" },
          results: {
            type: "array",
            items: { type: "object", properties: { testId: str, name: str, status: { type: "string", enum: ["passed", "failed", "skipped"] }, message: str, durationMs: { type: "number" } }, required: ["status"] },
          },
          junitXml: str,
        },
      },
      scope: "report",
      run: async (c, a) => {
        const p = await projectFor(c, a.projectId, "report");
        const input = ctx.parseOrThrow(TestRunInput, a);
        const results = input.junitXml ? junit(input.junitXml) : (input.results ?? []);
        return recordTestRun(c, p, { tool: input.tool, revision: input.revision, url: input.url, format: input.junitXml ? "junit" : "json", results });
      },
    },
    {
      name: "ask_question",
      title: "要件についての質問",
      description: "要件があいまい・矛盾している・足りないときに、推測で実装せずに質問します。回答は list_questions で確認できます",
      inputSchema: { type: "object", properties: { ...pid, text: str, requirementCode: str, context: { type: "string", description: "状況（関係するファイル・試したこと など）" } }, required: ["text"] },
      scope: "report",
      run: async (c, a) => ask(c, await projectFor(c, a.projectId, "report"), ctx.parseOrThrow(QuestionInput, a)),
    },
  ];

  const MCP_INSTRUCTIONS = `要件ナビ（要件定義の管理）に接続しています。
作業の進め方:
1. get_project_overview で目的・着手前チェック・未決事項を確認する
2. 実装する要件ごとに get_requirement で要件文（EARS）・テストケース・画面・データ項目を読む
3. 要件にない機能は作らない。あいまいなときは推測せず ask_question で質問する
4. テスト名にテストID（TC-FR-01-1 など）を含め、実行したら report_test_results で報告する
5. 実装を始めたら・終えたら report_implementation で報告する（プルリクエストのURLを refs に付ける）`;

  type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
  const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function handleRpc(c: AnyContext, m: RpcMessage) {
    const isNotification = m.id === undefined || m.id === null;
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return isNotification ? null : rpcError(m?.id, -32600, "Invalid Request");
    if (isNotification) return null; // notifications/initialized など
    switch (m.method) {
      case "initialize": {
        const requested = String(m.params?.protocolVersion ?? "");
        return {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: MCP_INSTRUCTIONS,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id: m.id, result: {} };
      case "tools/list": {
        const t = tokenOf(c);
        const usable = TOOLS.filter((x) => !t || t.scopes.includes(x.scope));
        return { jsonrpc: "2.0", id: m.id, result: { tools: usable.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) } };
      }
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const tool = TOOLS.find((x) => x.name === name);
        if (!tool) return rpcError(m.id, -32602, `ツールがありません: ${name}`);
        try {
          const data = await tool.run(c, m.params?.arguments ?? {});
          return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false } };
        } catch (e) {
          const msg = e instanceof HTTPException ? e.message : e instanceof z.ZodError ? `入力が正しくありません: ${e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("、")}` : "処理に失敗しました";
          if (!(e instanceof HTTPException) && !(e instanceof z.ZodError)) console.error(e);
          return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: msg }], isError: true } };
        }
      }
      default:
        return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  function junit(xml: string): RawTestResult[] {
    try {
      return parseJUnitXml(xml);
    } catch (e) {
      if (e instanceof JUnitParseError) throw new HTTPException(400, { message: e.message });
      throw e;
    }
  }

  /* ---------- ルート ---------- */

  function routes(app: Hono<any>) {
    /* 管理者: トークン */
    app.get("/api/orgs/:orgId/api-tokens", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "agent.manage");
      return c.json((await store.listApiTokens(orgId)).map(publicToken));
    });
    app.post("/api/orgs/:orgId/api-tokens", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "agent.manage");
      if (tokenOf(c)) throw new HTTPException(403, { message: "トークンでトークンは発行できません" });
      const input = await ctx.body(c, TokenInput);
      if (input.projectIds) {
        const mine = new Set((await store.listProjects(orgId)).map((p) => p.id));
        const bad = input.projectIds.filter((x) => !mine.has(x));
        if (bad.length) throw new HTTPException(400, { message: `この組織のプロジェクトではありません: ${bad.join(", ")}` });
      }
      const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const t = await store.createApiToken({
        orgId,
        name: input.name,
        tokenHash: hashToken(raw),
        last4: raw.slice(-4),
        scopes: [...new Set<TokenScope>(["read", ...input.scopes])],
        projectIds: input.projectIds,
        expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
        createdBy: ctx.actorOf(c),
      });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "token.create", targetType: "api_token", targetId: t.id, detail: { name: t.name, scopes: t.scopes, projectIds: t.projectIds, expiresAt: t.expiresAt } });
      // トークンはこの応答でだけ返す（保存しているのはハッシュだけ）
      return c.json({ ...publicToken(t), token: raw }, 201);
    });
    app.delete("/api/orgs/:orgId/api-tokens/:id", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "agent.manage");
      if (!(await store.revokeApiToken(orgId, c.req.param("id")))) throw new HTTPException(404, { message: "トークンが見つかりません" });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "token.revoke", targetType: "api_token", targetId: c.req.param("id") });
      return c.body(null, 204);
    });

    /* 管理者: Webhook */
    app.get("/api/orgs/:orgId/webhooks", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "agent.manage");
      return c.json((await store.listWebhooks(orgId)).map(publicWebhook));
    });
    app.post("/api/orgs/:orgId/webhooks", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "agent.manage");
      const input = await ctx.body(c, WebhookInput);
      await checkWebhookTarget(input.url);
      const secret = `whsec_${randomBytes(24).toString("base64url")}`;
      const w = await store.addWebhook({ orgId, url: input.url, events: input.events, encryptedSecret: await opts.encryptor.encrypt(secret, { orgId }), createdBy: ctx.actorOf(c) });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "webhook.create", targetType: "webhook", targetId: w.id, detail: { url: w.url, events: w.events } });
      return c.json({ ...publicWebhook(w), secret }, 201);
    });
    app.delete("/api/orgs/:orgId/webhooks/:id", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "agent.manage");
      if (!(await store.deleteWebhook(orgId, c.req.param("id")))) throw new HTTPException(404, { message: "Webhook が見つかりません" });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "webhook.delete", targetType: "webhook", targetId: c.req.param("id") });
      return c.body(null, 204);
    });
    app.post("/api/orgs/:orgId/webhooks/:id/test", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "agent.manage");
      const w = (await store.listWebhooks(orgId)).find((x) => x.id === c.req.param("id"));
      if (!w) throw new HTTPException(404, { message: "Webhook が見つかりません" });
      const st = await deliver(w, "ping", { message: "要件ナビからの接続確認です" });
      return c.json({ ok: /^HTTP 2\d\d$/.test(st), status: st });
    });

    /* 画面: 実装・テストの状況と、質問への回答 */
    app.get("/api/projects/:id/connect", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      const runs = await store.listTestRuns(p.id, 10);
      return c.json({
        status: await status(p),
        runs: runs.map((r) => ({ id: r.id, tool: r.tool, revision: r.revision, url: r.url, format: r.format, summary: r.summary, unmatched: r.unmatched.slice(0, 20), createdBy: r.createdBy, createdAt: r.createdAt })),
        questions: await store.listQuestions(p.id),
        server: serverUrl(c),
      });
    });
    app.post("/api/questions/:id/answer", async (c) => {
      const q = await store.getQuestion(c.req.param("id"));
      if (!q) throw new HTTPException(404, { message: "質問が見つかりません" });
      const p = await ctx.loadProject(c, q.projectId, "requirements.edit");
      const input = await ctx.body(c, AnswerInput);
      const actor = ctx.actorOf(c);
      const a = await store.answerQuestion(q.id, { status: input.status, answer: input.answer, answeredBy: actor });
      await audit(store, { orgId: p.orgId, actor, action: "question.answer", targetType: "project", targetId: p.id, detail: { code: q.code, status: input.status } });
      emit(p.orgId, "question.answered", { projectId: p.id, code: q.code, requirementCode: q.requirementCode, status: input.status, answer: input.answer });
      return c.json(a);
    });

    /* 外部連携 API */
    app.use("/api/v1/*", tokenAuth);
    app.get("/api/v1/openapi.json", (c) => c.json(openApiDocument(serverUrl(c))));
    app.get("/api/v1/projects", async (c) => c.json((await accessibleProjects(c)).map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, createdAt: p.createdAt }))));
    app.get("/api/v1/projects/:id", async (c) => c.json(await overview(await projectFor(c, c.req.param("id"), "read"))));
    app.get("/api/v1/projects/:id/requirements", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "read");
      return c.json(await requirementsOf(p, { type: c.req.query("type") || undefined, codes: c.req.query("codes")?.split(",").filter(Boolean) }));
    });
    app.get("/api/v1/projects/:id/requirements/:code", async (c) => c.json(await requirementDetail(await projectFor(c, c.req.param("id"), "read"), c.req.param("code"))));
    app.get("/api/v1/projects/:id/design", async (c) => c.json(await designOf(await projectFor(c, c.req.param("id"), "read"), c.req.query("part") || undefined)));
    app.get("/api/v1/projects/:id/tests", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "read");
      return c.json(await testCasesOf(p, { requirementCode: c.req.query("requirement") || undefined, level: c.req.query("level") || undefined }));
    });
    app.get("/api/v1/projects/:id/handoff", async (c) => c.json(await ho.bundle(await projectFor(c, c.req.param("id"), "read"))));
    app.get("/api/v1/projects/:id/status", async (c) => c.json(await status(await projectFor(c, c.req.param("id"), "read"))));
    app.get("/api/v1/projects/:id/glossary", async (c) => c.json(await needScope().glossary(await projectFor(c, c.req.param("id"), "read"))));
    app.get("/api/v1/projects/:id/acceptance", async (c) => c.json(await needScope().acceptance(await projectFor(c, c.req.param("id"), "read"))));
    app.get("/api/v1/projects/:id/diff", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "read");
      const num = (k: string) => {
        const v = c.req.query(k);
        if (!v || v === "current") return undefined;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new HTTPException(400, { message: `${k} は版の番号です` });
        return n;
      };
      return c.json(await needScope().diff(p, num("from"), num("to")));
    });
    app.get("/api/v1/projects/:id/agent-pack.zip", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "read");
      const zip = await agentPack(c, p);
      const utf8 = encodeURIComponent(`${p.name}_開発用パッケージ.zip`);
      return c.body(new Uint8Array(zip), 200, { "content-type": "application/zip", "content-disposition": `attachment; filename="agent-pack.zip"; filename*=UTF-8''${utf8}` });
    });
    app.post("/api/v1/projects/:id/implementation", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "report");
      return c.json(await reportImplementation(c, p, await ctx.body(c, ImplInput)), 201);
    });
    app.post("/api/v1/projects/:id/test-runs", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "report");
      const ct = c.req.header("content-type") ?? "";
      const q = (k: string) => (c.req.query(k) ?? "").slice(0, k === "url" ? 500 : 100);
      if (/xml/.test(ct)) {
        const len = Number(c.req.header("content-length") ?? 0);
        if (len > 10 * 1024 * 1024) throw new HTTPException(413, { message: "テスト結果が大きすぎます（10MBまで）" });
        const results = junit(await c.req.text());
        return c.json(await recordTestRun(c, p, { tool: q("tool"), revision: q("revision"), url: q("url"), format: "junit", results }), 201);
      }
      const input = await ctx.body(c, TestRunInput);
      const results = input.junitXml ? junit(input.junitXml) : (input.results ?? []);
      return c.json(await recordTestRun(c, p, { tool: input.tool, revision: input.revision, url: input.url, format: input.junitXml ? "junit" : "json", results }), 201);
    });
    app.get("/api/v1/projects/:id/test-runs", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "read");
      return c.json((await store.listTestRuns(p.id, 50)).map(({ tests: _t, requirements: _r, ...rest }) => rest));
    });
    app.post("/api/v1/projects/:id/questions", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "report");
      return c.json(await ask(c, p, await ctx.body(c, QuestionInput)), 201);
    });
    app.get("/api/v1/projects/:id/questions", async (c) => {
      const p = await projectFor(c, c.req.param("id"), "read");
      const st = c.req.query("status");
      return c.json((await store.listQuestions(p.id)).filter((q) => !st || q.status === st));
    });

    /* MCP（Streamable HTTP。セッションを持たず、応答は JSON で返す） */
    app.use("/mcp", tokenAuth);
    app.post("/mcp", async (c) => {
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(c.req.url).origin && origin !== serverUrl(c)) throw new HTTPException(403, { message: "許可されていない Origin です" });
      let msg: RpcMessage | RpcMessage[];
      try {
        msg = await c.req.json();
      } catch {
        return c.json(rpcError(null, -32700, "Parse error"), 400);
      }
      if (Array.isArray(msg)) {
        if (!msg.length) return c.json(rpcError(null, -32600, "Invalid Request"), 400);
        const out = (await Promise.all(msg.slice(0, 50).map((m) => handleRpc(c, m)))).filter(Boolean);
        return out.length ? c.json(out) : c.body(null, 202);
      }
      const res = await handleRpc(c, msg);
      return res ? c.json(res) : c.body(null, 202);
    });
    app.get("/mcp", (c) => c.body(null, 405, { allow: "POST" }));
    app.delete("/mcp", (c) => c.body(null, 405, { allow: "POST" }));
  }

  return {
    routes,
    emit,
    status,
    agentFiles,
    /** テスト用: 送信中の Webhook を待つ */
    flush: async () => {
      await Promise.all([...pending]);
    },
    tools: TOOLS.map((t) => t.name),
  };
}
