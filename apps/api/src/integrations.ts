/**
 * 課題管理ツール（GitHub Issues / Jira / Backlog）への登録。
 * - エピックを親の課題、ストーリーを子の課題として登録する（タスクは本文のチェックリスト）
 * - 前回までに登録済みのものは飛ばすため、途中で失敗しても再実行で続きから登録できる
 * - トークンはリクエストのヘッダー（Backlog はクエリ）にだけ使い、エラーやログには出さない
 * - 外部への通信はすべて fetchImpl 経由（テストでは差し替える）
 */
import { epicBody, storyBody, type FetchLike, type PlanEpic, type PlanStory, type TaskPlan, type TaskRequirement } from "@arn/ai-core";
import { z } from "zod";
import type { ExportItem, IntegrationKind } from "./store.js";

/* ------------------------------------------------------------------ */
/* 接続設定                                                             */
/* ------------------------------------------------------------------ */

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "https:// で始まるURLを指定してください")
  .transform((u) => u.replace(/\/+$/, ""));
const name = (re: RegExp, msg: string) => z.string().min(1).max(100).regex(re, msg);

export const INTEGRATION_CONFIG = {
  github: z
    .object({
      owner: name(/^[A-Za-z0-9_.-]+$/, "所有者名に使えない文字があります"),
      repo: name(/^[A-Za-z0-9_.-]+$/, "リポジトリ名に使えない文字があります"),
      /** GitHub Enterprise Server では https://ホスト/api/v3 */
      apiBase: httpsUrl.default("https://api.github.com"),
      /** カンマ区切り */
      labels: z.string().max(200).default("requirements-navigator"),
    })
    .strict(),
  jira: z
    .object({
      baseUrl: httpsUrl,
      /** Jira Cloud はメールアドレス＋APIトークン。空なら Bearer（Data Center の個人用アクセストークン） */
      email: z.string().max(200).default(""),
      projectKey: name(/^[A-Z][A-Z0-9_]+$/, "プロジェクトキーは英大文字で始まる英数字です"),
      epicType: z.string().min(1).max(50).default("Epic"),
      storyType: z.string().min(1).max(50).default("Story"),
    })
    .strict(),
  backlog: z
    .object({
      /** https://スペース.backlog.jp など */
      spaceUrl: httpsUrl,
      projectKey: name(/^[A-Z][A-Z0-9_]+$/, "プロジェクトキーは英大文字で始まる英数字です"),
      issueType: z.string().min(1).max(50).default("タスク"),
    })
    .strict(),
} as const;

export function parseIntegrationConfig(kind: IntegrationKind, config: unknown): Record<string, string> {
  return INTEGRATION_CONFIG[kind].parse(config) as Record<string, string>;
}

export function integrationTarget(kind: IntegrationKind, config: Record<string, string>): string {
  if (kind === "github") return `${config.owner}/${config.repo}`;
  const base = kind === "jira" ? config.baseUrl : config.spaceUrl;
  return `${new URL(base!).host} ${config.projectKey}`;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

/** 外部ツールのエラー本文から、利用者に見せられる説明を取り出す（トークンは含まれない） */
function describe(status: number, body: unknown, text: string): string {
  const b = body as any;
  const parts: string[] = [];
  if (b && typeof b === "object") {
    if (typeof b.message === "string") parts.push(b.message);
    if (Array.isArray(b.errors)) {
      for (const e of b.errors) parts.push(typeof e === "string" ? e : (e?.message ?? e?.code ?? JSON.stringify(e)));
    } else if (b.errors && typeof b.errors === "object") {
      for (const [k, v] of Object.entries(b.errors)) parts.push(`${k}: ${v}`);
    }
    if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages);
  }
  const hint =
    status === 401 ? "（トークンが無効か期限切れです）" : status === 403 ? "（トークンの権限が足りません）" : status === 404 ? "（リポジトリ・プロジェクトが見つからないか、見る権限がありません）" : "";
  const msg = parts.filter(Boolean).join(" / ") || text.replace(/\s+/g, " ").slice(0, 200);
  return `HTTP ${status}${hint}${msg ? ` ${msg}` : ""}`.slice(0, 400);
}

interface Http {
  (method: string, url: string, body?: unknown, opts?: { form?: boolean }): Promise<any>;
}

function http(fetchImpl: FetchLike, headers: Record<string, string>, timeoutMs: number): Http {
  return async (method, url, body, opts = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const h: Record<string, string> = { accept: "application/json", "user-agent": "requirements-navigator", ...headers };
      let payload: string | undefined;
      if (body !== undefined) {
        if (opts.form) {
          h["content-type"] = "application/x-www-form-urlencoded";
          const f = new URLSearchParams();
          for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (v !== undefined && v !== null) f.append(k, String(v));
          payload = f.toString();
        } else {
          h["content-type"] = "application/json";
          payload = JSON.stringify(body);
        }
      }
      let res: Response;
      try {
        res = await fetchImpl(url, { method, headers: h, body: payload, signal: ctrl.signal, redirect: "error" });
      } catch (e) {
        throw new IntegrationError(ctrl.signal.aborted ? "接続先が時間内に応答しませんでした" : `接続できませんでした: ${(e as Error).message}`);
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* JSON以外 */
      }
      if (!res.ok) throw new IntegrationError(describe(res.status, json, text), res.status);
      return json;
    } finally {
      clearTimeout(timer);
    }
  };
}

const safeUrl = (u: unknown, fallback: string) => (typeof u === "string" && /^https:\/\//.test(u) ? u : fallback);

/* ------------------------------------------------------------------ */
/* ツールごとの登録処理                                                  */
/* ------------------------------------------------------------------ */

interface Created {
  url: string;
  externalKey: string;
  externalId: string;
  note?: string;
}

interface Client {
  /** 接続確認（リポジトリ・プロジェクトを読めるか） */
  check(): Promise<string>;
  createEpic(epic: PlanEpic): Promise<Created>;
  createStory(story: PlanStory, epic: PlanEpic, parent: Created | null): Promise<Created>;
  /** すべて登録した後に、エピックの本文へストーリーへのリンクを足す（対応するツールのみ） */
  linkEpic?(epic: PlanEpic, parent: Created, stories: Array<{ story: PlanStory; ref: Created }>): Promise<void>;
}

interface ClientContext {
  config: Record<string, string>;
  secret: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  reqs: TaskRequirement[];
}

/** 一部の項目（ラベル・親子関係など）が原因で失敗したら、その項目を外して1回だけやり直す */
async function withFallback<T>(first: () => Promise<T>, retry: () => Promise<T>, note: string): Promise<{ value: T; note?: string }> {
  try {
    return { value: await first() };
  } catch (e) {
    if (!(e instanceof IntegrationError) || (e.status !== 400 && e.status !== 422)) throw e;
    return { value: await retry(), note: `${note}（${e.message}）` };
  }
}

function github(ctx: ClientContext): Client {
  const { owner, repo, apiBase } = ctx.config as Record<string, string>;
  const call = http(ctx.fetchImpl, { authorization: `Bearer ${ctx.secret}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, ctx.timeoutMs);
  const base = `${apiBase}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}`;
  const labels = (ctx.config.labels ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const create = async (title: string, body: string, extra: string[]): Promise<Created> => {
    const all = [...labels, ...extra];
    const { value: r, note } = await withFallback(
      () => call("POST", `${base}/issues`, { title, body, labels: all }),
      () => call("POST", `${base}/issues`, { title, body }),
      "ラベルを付けられなかったため、ラベルなしで登録しました",
    );
    return {
      url: safeUrl(r?.html_url, `https://github.com/${owner}/${repo}/issues/${r?.number}`),
      externalKey: `#${r?.number}`,
      externalId: String(r?.number),
      note,
    };
  };
  return {
    async check() {
      const r = await call("GET", base);
      if (r?.has_issues === false) throw new IntegrationError("このリポジトリでは Issues が無効になっています");
      return `${r?.full_name ?? `${owner}/${repo}`} に接続できました`;
    },
    createEpic: (e) => create(`[エピック] ${e.title}`, epicBody(e), labels.length ? ["epic"] : []),
    createStory: (s, e, parent) =>
      create(s.title, `${parent ? `エピック: ${parent.externalKey}\n\n` : ""}${storyBody(s, e, ctx.reqs)}`, []),
    async linkEpic(e, parent, stories) {
      const list = stories.map(({ story, ref }) => `- [ ] ${ref.externalKey} ${story.key} ${story.title}`).join("\n");
      await call("PATCH", `${base}/issues/${parent.externalId}`, { body: `${epicBody(e)}\n\n### 課題\n${list}` });
    },
  };
}

function jira(ctx: ClientContext): Client {
  const { baseUrl, email, projectKey, epicType, storyType } = ctx.config as Record<string, string>;
  const auth = email ? `Basic ${Buffer.from(`${email}:${ctx.secret}`).toString("base64")}` : `Bearer ${ctx.secret}`;
  const call = http(ctx.fetchImpl, { authorization: auth }, ctx.timeoutMs);
  const create = async (fields: Record<string, unknown>, parentKey?: string): Promise<Created> => {
    const base = { project: { key: projectKey }, labels: ["requirements-navigator"], ...fields };
    const { value: r, note } = parentKey
      ? await withFallback(
          () => call("POST", `${baseUrl}/rest/api/2/issue`, { fields: { ...base, parent: { key: parentKey } } }),
          () => call("POST", `${baseUrl}/rest/api/2/issue`, { fields: base }),
          "エピックの子として登録できなかったため、親なしで登録しました",
        )
      : { value: await call("POST", `${baseUrl}/rest/api/2/issue`, { fields: base }), note: undefined };
    return { url: `${baseUrl}/browse/${encodeURIComponent(r?.key)}`, externalKey: String(r?.key), externalId: String(r?.id), note };
  };
  return {
    async check() {
      const r = await call("GET", `${baseUrl}/rest/api/2/project/${encodeURIComponent(projectKey!)}`);
      return `${r?.name ?? projectKey}（${projectKey}）に接続できました`;
    },
    createEpic: (e) => create({ summary: e.title, description: epicBody(e, "jira"), issuetype: { name: epicType } }),
    createStory: (s, e, parent) => create({ summary: s.title, description: storyBody(s, e, ctx.reqs, "jira"), issuetype: { name: storyType } }, parent?.externalKey),
  };
}

function backlog(ctx: ClientContext): Client {
  const { spaceUrl, projectKey, issueType } = ctx.config as Record<string, string>;
  const call = http(ctx.fetchImpl, {}, ctx.timeoutMs);
  const api = (path: string) => `${spaceUrl}/api/v2${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(ctx.secret)}`;
  let meta: Promise<{ projectId: number; issueTypeId: number }> | null = null;
  const loadMeta = () =>
    (meta ??= (async () => {
      const p = await call("GET", api(`/projects/${encodeURIComponent(projectKey!)}`));
      const types: Array<{ id: number; name: string }> = (await call("GET", api(`/projects/${p.id}/issueTypes`))) ?? [];
      const t = types.find((x) => x.name === issueType) ?? types[0];
      if (!t) throw new IntegrationError("プロジェクトに種別がありません");
      return { projectId: p.id, issueTypeId: t.id };
    })());
  const must = (codes: string[]) => codes.some((c) => ctx.reqs.find((r) => r.code === c)?.priority === "must");
  const create = async (summary: string, description: string, priorityId: number, parent: Created | null): Promise<Created> => {
    const m = await loadMeta();
    const fields = { projectId: m.projectId, issueTypeId: m.issueTypeId, priorityId, summary, description };
    const { value: r, note } = parent
      ? await withFallback(
          () => call("POST", api("/issues"), { ...fields, parentIssueId: parent.externalId }, { form: true }),
          () => call("POST", api("/issues"), fields, { form: true }),
          "親子課題が使えなかったため、親なしで登録しました（プロジェクト設定で「親子課題」を有効にすると親子で登録できます）",
        )
      : { value: await call("POST", api("/issues"), fields, { form: true }), note: undefined };
    return { url: `${spaceUrl}/view/${encodeURIComponent(r?.issueKey)}`, externalKey: String(r?.issueKey), externalId: String(r?.id), note };
  };
  return {
    async check() {
      const m = await loadMeta();
      return `${projectKey} に接続できました（プロジェクトID ${m.projectId}）`;
    },
    // 優先度: 2=高, 3=中
    createEpic: (e) => create(`[エピック] ${e.title}`, epicBody(e), 3, null),
    createStory: (s, e, parent) => create(`${s.title}`, storyBody(s, e, ctx.reqs), must(s.requirementCodes) ? 2 : 3, parent),
  };
}

const CLIENTS: Record<IntegrationKind, (ctx: ClientContext) => Client> = { github, jira, backlog };

/* ------------------------------------------------------------------ */
/* 登録の実行                                                           */
/* ------------------------------------------------------------------ */

export interface ExportRequest {
  kind: IntegrationKind;
  config: Record<string, string>;
  secret: string;
  plan: TaskPlan;
  reqs: TaskRequirement[];
  /** 登録するストーリー。省略時はすべて */
  storyKeys?: string[];
  /** 前回までに登録済みの項目（キー → 結果）。これらは登録しない */
  already?: Map<string, ExportItem>;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => Promise<void> | void;
}

export async function checkIntegration(kind: IntegrationKind, config: Record<string, string>, secret: string, fetchImpl: FetchLike, timeoutMs = 15_000) {
  return CLIENTS[kind]({ config, secret, fetchImpl, timeoutMs, reqs: [] }).check();
}

export async function exportPlan(req: ExportRequest): Promise<ExportItem[]> {
  const client = CLIENTS[req.kind]({ config: req.config, secret: req.secret, fetchImpl: req.fetchImpl, timeoutMs: req.timeoutMs ?? 30_000, reqs: req.reqs });
  const wanted = req.storyKeys ? new Set(req.storyKeys) : null;
  const already = req.already ?? new Map<string, ExportItem>();
  const ref = (x: ExportItem): Created => ({ url: x.url ?? "", externalKey: x.externalKey ?? "", externalId: x.externalId ?? "" });
  const items: ExportItem[] = [];
  const work = req.plan.epics.map((e) => ({ epic: e, stories: e.stories.filter((s) => !wanted || wanted.has(s.key)) })).filter((w) => w.stories.length);
  const total = work.reduce((a, w) => a + 1 + w.stories.length, 0);
  let done = 0;
  const tick = async () => {
    done++;
    await req.onProgress?.(done, total);
  };

  for (const { epic, stories } of work) {
    let parent: Created | null = null;
    const prev = already.get(epic.key);
    if (prev?.status === "created" || prev?.status === "skipped") {
      parent = ref(prev);
      items.push({ ...prev, key: epic.key, type: "epic", title: epic.title, status: "skipped", note: "登録済み" });
    } else {
      try {
        parent = await client.createEpic(epic);
        items.push({ key: epic.key, type: "epic", title: epic.title, status: "created", ...parent });
      } catch (e) {
        items.push({ key: epic.key, type: "epic", title: epic.title, status: "failed", error: (e as Error).message });
        // 認証エラーなどは続けても同じなので打ち切る
        if (e instanceof IntegrationError && (e.status === 401 || e.status === 403 || e.status === 404)) {
          for (const s of stories) items.push({ key: s.key, type: "story", title: s.title, status: "failed", error: "エピックの登録に失敗したため中止しました" });
          return items;
        }
      }
    }
    await tick();

    const linked: Array<{ story: PlanStory; ref: Created }> = [];
    let added = false;
    for (const s of stories) {
      const p = already.get(s.key);
      if (p?.status === "created" || p?.status === "skipped") {
        items.push({ ...p, key: s.key, type: "story", title: s.title, status: "skipped", note: "登録済み" });
        linked.push({ story: s, ref: ref(p) });
      } else {
        try {
          const r = await client.createStory(s, epic, parent);
          items.push({ key: s.key, type: "story", title: s.title, status: "created", ...r });
          linked.push({ story: s, ref: r });
          added = true;
        } catch (e) {
          items.push({ key: s.key, type: "story", title: s.title, status: "failed", error: (e as Error).message });
        }
      }
      await tick();
    }
    if (parent && added && client.linkEpic) {
      try {
        await client.linkEpic(epic, parent, linked);
      } catch (e) {
        const it = items.find((x) => x.key === epic.key)!;
        it.note = `${it.note ? `${it.note} ／ ` : ""}エピックの本文にストーリーの一覧を追記できませんでした（${(e as Error).message}）`;
      }
    }
  }
  return items;
}
