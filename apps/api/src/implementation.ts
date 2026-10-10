/**
 * 実装工程への連携の API（機能 F7）。
 * - タスク分解: 確定した要件（と採用したUML）→ エピック・ストーリー・タスク
 * - 課題管理ツールとの接続（組織ごと・管理者が登録）と、課題の一括登録
 * - トレーサビリティ: 要件 → ストーリー → 登録した課題
 */
import {
  ESTIMATES,
  generateTaskPlan,
  summarizeUmlModel,
  TASK_TARGET_TYPES,
  toBacklogCsv,
  toJiraCsv,
  toTaskMarkdown,
  traceRequirements,
  type AIProvider,
  type FetchLike,
  type TaskRequirement,
} from "@arn/ai-core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Permission } from "./permissions.js";
import { maskKey, type KeyEncryptor } from "./crypto.js";
import {
  checkIntegration,
  discoverIntegration,
  exportPlan,
  INTEGRATION_CONFIG,
  integrationTarget,
  IntegrationError,
  parseIntegrationUrl,
  prepareIntegration,
} from "./integrations.js";
import type { ExportItem, Integration, JobProgress, Project, Requirement, Store, TaskExport, TaskPlanRecord } from "./store.js";
import { usageOf } from "./store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyContext = Context<any>;

export interface ImplementationContext {
  store: Store;
  encryptor: KeyEncryptor;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  need: (c: AnyContext, orgId: string, perm: Permission) => void;
  loadProject: (c: AnyContext, id: string, perm: Permission) => Promise<Project>;
  /** ログインしている人がそのプロジェクトを見られるか（メンバーを限ったプロジェクトの判定） */
  canView?: (c: AnyContext, p: Project) => Promise<boolean>;
  actorOf: (c: AnyContext) => string;
  body: <T extends z.ZodTypeAny>(c: Context, schema: T) => Promise<z.infer<T>>;
  parseOrThrow: <T extends z.ZodTypeAny>(schema: T, json: unknown) => z.infer<T>;
  budget: (orgId: string, ids: string[]) => Promise<{ excluded: Set<string>; warnings: string[] }>;
  providersOf: (orgId: string, ids: string[]) => Promise<AIProvider[]>;
  labelsOf: (orgId: string) => Promise<Map<string, string>>;
  /** 外部（Webhook）への通知。処理は待たない */
  emit?: (orgId: string, event: string, data: Record<string, unknown>) => void;
}

const KindSchema = z.enum(["github", "jira", "backlog"]);
const IntegrationInput = z.object({
  kind: KindSchema,
  label: z.string().min(1).max(100).optional(),
  config: z.record(z.string(), z.string()),
  /** GitHub: 個人用アクセストークン（Issues の書き込み権限） / Jira: APIトークン / Backlog: APIキー */
  token: z.string().min(1).max(500),
  /** true: 登録の後に準備（GitHub のラベル作成）と接続確認を自動で行い、結果を返す */
  setup: z.boolean().optional(),
});
/** 連携設定の自動化: トークン（または登録済みの連携先）で、選べる候補を取得する */
const DiscoverInput = z
  .object({
    kind: KindSchema,
    token: z.string().min(1).max(500).optional(),
    /** 登録済みの連携先のトークンを使う（変更のとき） */
    integrationId: z.string().min(1).optional(),
    /** リポジトリ・ボード・課題などの URL（接続先と対象を読み取る） */
    url: z.string().max(500).optional(),
    config: z.record(z.string(), z.string().max(200)).optional(),
  })
  .refine((v) => v.token || v.integrationId, "トークンを入れてください");
const IntegrationPatchInput = z
  .object({
    label: z.string().min(1).max(100).optional(),
    /** 今の設定に上書きする項目だけを渡す */
    config: z.record(z.string(), z.string()).optional(),
    token: z.string().min(1).max(500).optional(),
  })
  .strict();
const RegisterInput = z.object({
  integrationId: z.string().min(1),
  /** 省略時は最新の分解結果 */
  planId: z.string().optional(),
  /** 登録するストーリー（E1-S1 など）。省略時はすべて */
  storyKeys: z.array(z.string()).max(1000).optional(),
});

export function publicIntegration(i: Integration) {
  return {
    id: i.id,
    kind: i.kind,
    label: i.label,
    config: i.config,
    target: integrationTarget(i.kind, i.config),
    token: maskKey(i.secretLast4),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

export const toTaskReqs = (rs: Requirement[]): TaskRequirement[] =>
  rs.map((r) => ({ code: r.code, type: r.type, title: r.title, description: r.description, priority: r.priority }));

/** 分解したときの要件と今の要件を比べ、変わった要件コードを返す */
export function changedSince(rec: { basis: Array<{ code: string; version: number }> }, current: Requirement[]): string[] {
  const before = new Map(rec.basis.map((b) => [b.code, b.version]));
  const now = new Map(current.map((r) => [r.code, r.version]));
  const out = new Set<string>();
  for (const [code, v] of now) if (before.get(code) !== v) out.add(code);
  for (const code of before.keys()) if (!now.has(code)) out.add(code);
  return [...out].sort();
}

/** 登録先ごとに最新の結果を集める（古い順に重ね、新しいもので上書きする） */
export function latestItems(exports: TaskExport[], integrationId?: string): Map<string, ExportItem & { integrationId: string; kind: string; target: string }> {
  const m = new Map<string, ExportItem & { integrationId: string; kind: string; target: string }>();
  for (const ex of [...exports].reverse()) {
    if (integrationId && ex.integrationId !== integrationId) continue;
    for (const it of ex.items) {
      if (it.status !== "created" && it.status !== "skipped") continue;
      m.set(`${ex.integrationId}:${it.key}`, { ...it, integrationId: ex.integrationId, kind: ex.kind, target: ex.target });
    }
  }
  return m;
}

export function implementation(ctx: ImplementationContext) {
  const { store } = ctx;

  const planView = async (rec: TaskPlanRecord, current: Requirement[], orgId: string) => {
    const labels = await ctx.labelsOf(orgId);
    const stories = rec.plan.epics.flatMap((e) => e.stories);
    const changed = changedSince(rec, current);
    return {
      id: rec.id,
      plan: rec.plan,
      provider: labels.get(rec.providerId) ?? rec.providerId,
      createdAt: rec.createdAt,
      stats: {
        epics: rec.plan.epics.length,
        stories: stories.length,
        tasks: stories.reduce((a, s) => a + s.tasks.length, 0),
        points: stories.reduce((a, s) => a + ESTIMATES[s.estimate].points, 0),
      },
      /** 分解した後に要件が変わったか */
      stale: changed.length > 0,
      changed,
    };
  };

  /* ------------------------------------------------------------------ */
  /* タスク分解                                                          */
  /* ------------------------------------------------------------------ */

  async function executeTasks(p: Project, actor: string, report?: (pr: JobProgress) => Promise<void>) {
    const current = await store.listRequirements(p.id);
    if (!current.some((r) => TASK_TARGET_TYPES.includes(r.type))) {
      throw new HTTPException(400, { message: "機能要件・非機能要件がまだありません。ヒアリングで要件を確定してから分解してください" });
    }
    // 生成AI → 評価AI の順に試す（評価は不要なので、使えるAIを順に使う）
    const ids = [...new Set([...p.aiConfig.generatorIds, ...(p.aiConfig.evaluatorId ? [p.aiConfig.evaluatorId] : [])])];
    const b = await ctx.budget(p.orgId, ids);
    const usable = ids.filter((id) => !b.excluded.has(id));
    if (!usable.length) throw new HTTPException(429, { message: `使えるAIがすべて今月の上限に達しています。${b.warnings.join(" ")}` });
    const providers = await ctx.providersOf(p.orgId, usable);
    if (p.confidential && providers.some((x) => !x.isLocal)) throw new HTTPException(400, { message: "機密プロジェクトではローカルLLMだけを使えます" });
    const labels = await ctx.labelsOf(p.orgId);
    const step = (status: "running" | "done" | "failed", reason?: string) =>
      report?.({ steps: [{ key: `generator:${usable[0]}`, label: `タスク分解: ${labels.get(usable[0]!) ?? usable[0]}`, status, reason }] });
    await step("running");

    const uml = await store.latestUmlModel(p.id);
    const reqs = toTaskReqs(current);
    let result: Awaited<ReturnType<typeof generateTaskPlan>>;
    try {
      result = await generateTaskPlan(providers, p.name, p.purpose, reqs, { design: uml ? summarizeUmlModel(uml.model) : "", timeoutMs: ctx.timeoutMs });
    } catch (e) {
      await step("failed", (e as Error).message);
      const failures = ((e as { failures?: Array<{ providerId: string; reason: string }> }).failures ?? []).map((f) => `${labels.get(f.providerId) ?? f.providerId}: ${f.reason}`);
      throw new HTTPException(502, { message: `${(e as Error).message}${failures.length ? `（${failures.join(" / ")}）` : ""}` });
    }
    await step("done");
    await store.addUsage({ orgId: p.orgId, providerId: result.providerId, projectId: p.id, ...usageOf(result.usage) });
    const rec = await store.saveTaskPlan({
      projectId: p.id,
      plan: result.plan,
      providerId: result.providerId,
      basis: current.map((r) => ({ code: r.code, version: r.version })),
      createdBy: actor,
    });
    await audit(store, {
      orgId: p.orgId,
      actor,
      action: "ai.tasks",
      targetType: "task_plan",
      targetId: rec.id,
      detail: {
        projectId: p.id,
        sent: { requirements: reqs.length, design: Boolean(uml) },
        generators: [{ id: result.providerId, label: labels.get(result.providerId), tokens: usageOf(result.usage) }],
        failures: result.failures.map((f) => ({ id: f.providerId, label: labels.get(f.providerId), reason: f.reason })),
        uncovered: result.plan.uncovered,
      },
    });
    const warnings = [...b.warnings];
    if (result.plan.uncovered.length) warnings.push(`次の要件に対応するストーリーがありません: ${result.plan.uncovered.join(", ")}`);
    if (result.plan.unknownCodes.length) warnings.push(`AIが存在しない要件コードを出したため除きました: ${result.plan.unknownCodes.join(", ")}`);
    return {
      ...(await planView(rec, current, p.orgId)),
      failures: result.failures.map((f) => ({ provider: labels.get(f.providerId) ?? f.providerId, reason: f.reason })),
      warnings,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 課題管理ツールへの登録                                               */
  /* ------------------------------------------------------------------ */

  const findIntegration = async (orgId: string, id: string) => {
    const i = (await store.listIntegrations(orgId)).find((x) => x.id === id);
    if (!i) throw new HTTPException(404, { message: "連携先が見つかりません" });
    return i;
  };
  const planOf = async (p: Project, planId?: string) => {
    const rec = planId ? await store.getTaskPlan(planId) : await store.latestTaskPlan(p.id);
    if (!rec || rec.projectId !== p.id) throw new HTTPException(404, { message: "タスク分解の結果がありません。先に分解してください" });
    return rec;
  };
  const validateRegister = async (p: Project, input: z.infer<typeof RegisterInput>) => {
    const rec = await planOf(p, input.planId);
    const integ = await findIntegration(p.orgId, input.integrationId);
    const keys = new Set(rec.plan.epics.flatMap((e) => e.stories.map((s) => s.key)));
    const unknown = (input.storyKeys ?? []).filter((k) => !keys.has(k));
    if (unknown.length) throw new HTTPException(400, { message: `ストーリーがありません: ${unknown.join(", ")}` });
    if (input.storyKeys && !input.storyKeys.length) throw new HTTPException(400, { message: "登録するストーリーを1つ以上選んでください" });
    return { rec, integ };
  };

  async function executeRegister(p: Project, input: z.infer<typeof RegisterInput>, actor: string, report?: (pr: JobProgress) => Promise<void>) {
    const { rec, integ } = await validateRegister(p, input);
    const secret = await ctx.encryptor.decrypt(integ.encryptedSecret, { orgId: p.orgId });
    const prev = latestItems(await store.listTaskExports(rec.id), integ.id);
    const already = new Map([...prev.values()].map((x) => [x.key, x]));
    const target = integrationTarget(integ.kind, integ.config);
    await report?.({ message: `${target} に登録しています` });
    const items = await exportPlan({
      kind: integ.kind,
      config: integ.config,
      secret,
      plan: rec.plan,
      reqs: toTaskReqs(await store.listRequirements(p.id)),
      storyKeys: input.storyKeys,
      already,
      fetchImpl: ctx.fetchImpl,
      onProgress: (done, total) => report?.({ message: `${target} に登録しています（${done}/${total}）` }),
    });
    const ex = await store.saveTaskExport({ projectId: p.id, planId: rec.id, integrationId: integ.id, kind: integ.kind, target, items, createdBy: actor });
    const count = (s: ExportItem["status"]) => items.filter((x) => x.status === s).length;
    const summary = { created: count("created"), skipped: count("skipped"), failed: count("failed") };
    await audit(store, {
      orgId: p.orgId,
      actor,
      action: "tasks.export",
      targetType: "task_export",
      targetId: ex.id,
      detail: { projectId: p.id, planId: rec.id, integration: { id: integ.id, kind: integ.kind, label: integ.label, target }, ...summary },
    });
    return { id: ex.id, kind: integ.kind, target, items, summary, createdAt: ex.createdAt };
  }

  /* ------------------------------------------------------------------ */
  /* トレーサビリティ                                                     */
  /* ------------------------------------------------------------------ */

  async function trace(p: Project) {
    const current = await store.listRequirements(p.id);
    const rec = await store.latestTaskPlan(p.id);
    if (!rec) {
      return {
        plan: null,
        rows: current.map((r) => ({ code: r.code, type: r.type, title: r.title, target: TASK_TARGET_TYPES.includes(r.type), stories: [], status: "no_plan" })),
        summary: null,
      };
    }
    const exports = await store.listTaskExports(rec.id);
    const items = [...latestItems(exports).values()];
    const integrations = new Map((await store.listIntegrations(p.orgId)).map((i) => [i.id, i.label]));
    const linksOf = (key: string) =>
      items
        .filter((x) => x.key === key && x.url)
        .map((x) => ({ integration: integrations.get(x.integrationId) ?? x.target, kind: x.kind, externalKey: x.externalKey, url: x.url }));
    const changed = new Set(changedSince(rec, current));
    const rows = traceRequirements(rec.plan, toTaskReqs(current)).map((r) => {
      const stories = r.stories.map((s) => ({ ...s, links: linksOf(s.key) }));
      const status = !r.target
        ? "context"
        : !stories.length
          ? "uncovered"
          : stories.every((s) => s.links.length)
            ? "registered"
            : "planned";
      return { ...r, stories, changed: changed.has(r.code), status };
    });
    const targets = rows.filter((r) => r.target);
    return {
      plan: { id: rec.id, createdAt: rec.createdAt, stale: changed.size > 0 },
      rows,
      /** 分解後に削除された要件 */
      removed: rec.basis.map((b) => b.code).filter((c) => !current.some((r) => r.code === c)),
      summary: {
        targets: targets.length,
        covered: targets.filter((r) => r.stories.length).length,
        registered: targets.filter((r) => r.status === "registered").length,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* ルート                                                              */
  /* ------------------------------------------------------------------ */

  function routes(
    app: Hono<any>,
    jobs: {
      wantsAsync: (c: Context) => boolean;
      enqueue: (c: AnyContext, p: Project, kind: "tasks" | "export", input: Record<string, unknown>) => Promise<Response>;
    },
  ) {
    // 連携先（組織の管理者が登録。一覧は登録先を選ぶため閲覧者以上が見られる。トークンは返さない）
    app.get("/api/orgs/:orgId/integrations", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "project.view");
      return c.json((await store.listIntegrations(orgId)).map(publicIntegration));
    });

    app.post("/api/orgs/:orgId/integrations", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "integration.manage");
      const input = await ctx.body(c, IntegrationInput);
      const config: Record<string, string> = ctx.parseOrThrow(INTEGRATION_CONFIG[input.kind], input.config);
      const target = integrationTarget(input.kind, config);
      const i = await store.addIntegration({
        orgId,
        kind: input.kind,
        label: input.label ?? `${input.kind} ${target}`,
        config,
        encryptedSecret: await ctx.encryptor.encrypt(input.token, { orgId }),
        secretLast4: input.token.slice(-4),
      });
      await audit(store, {
        orgId,
        actor: ctx.actorOf(c),
        action: "integration.create",
        targetType: "integration",
        targetId: i.id,
        detail: { kind: i.kind, label: i.label, config },
      });
      if (!input.setup) return c.json(publicIntegration(i), 201);
      // 準備（GitHub のラベル作成）と接続確認を自動で行う。失敗しても登録はそのまま
      const setup = await prepareIntegration(i.kind, config, input.token, ctx.fetchImpl).catch((e) => [`準備に失敗しました（${(e as Error).message}）`]);
      const check = await checkIntegration(i.kind, config, input.token, ctx.fetchImpl).then(
        (message) => ({ ok: true, message }),
        (e) => ({ ok: false, message: e instanceof IntegrationError ? e.message : "接続確認に失敗しました" }),
      );
      return c.json({ ...publicIntegration(i), setup, check }, 201);
    });

    /** 連携設定の自動化: トークンの持ち主を確かめ、選べるリポジトリ・プロジェクト・種別・ラベルを返す（トークンは保存しない） */
    app.post("/api/orgs/:orgId/integrations/discover", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "integration.manage");
      const input = await ctx.body(c, DiscoverInput);
      let token = input.token?.trim() ?? "";
      let base: Record<string, string> = {};
      if (input.integrationId) {
        const cur = await findIntegration(orgId, input.integrationId);
        if (cur.kind !== input.kind) throw new HTTPException(400, { message: "連携先の種類が違います" });
        base = { ...cur.config };
        if (!token) token = await ctx.encryptor.decrypt(cur.encryptedSecret, { orgId });
      }
      try {
        const fromUrl = input.url?.trim() ? parseIntegrationUrl(input.kind, input.url) : {};
        // 空の値は「指定なし」として扱う
        const given = Object.fromEntries(Object.entries({ ...base, ...fromUrl, ...(input.config ?? {}) }).filter(([, v]) => v !== ""));
        if (input.kind === "jira" && input.config && "email" in input.config) given.email = input.config.email ?? "";
        for (const k of ["apiBase", "baseUrl", "spaceUrl"]) {
          if (given[k] && !/^https:\/\//.test(given[k]!)) return c.json({ ok: false, message: "接続先の URL は https:// で始めてください" });
        }
        const r = await discoverIntegration(input.kind, given, token, ctx.fetchImpl);
        return c.json({ ok: true, ...r, fromUrl });
      } catch (e) {
        if (e instanceof IntegrationError) return c.json({ ok: false, message: e.message });
        throw e;
      }
    });

    app.patch("/api/orgs/:orgId/integrations/:id", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "integration.manage");
      const input = await ctx.body(c, IntegrationPatchInput);
      const cur = await findIntegration(orgId, c.req.param("id"));
      const config = input.config
        ? (ctx.parseOrThrow(INTEGRATION_CONFIG[cur.kind], { ...cur.config, ...input.config }) as Record<string, string>)
        : undefined;
      const updated = await store.updateIntegration(orgId, cur.id, {
        label: input.label,
        config,
        encryptedSecret: input.token ? await ctx.encryptor.encrypt(input.token, { orgId }) : undefined,
        secretLast4: input.token ? input.token.slice(-4) : undefined,
      });
      if (!updated) throw new HTTPException(404, { message: "連携先が見つかりません" });
      await audit(store, {
        orgId,
        actor: ctx.actorOf(c),
        action: "integration.update",
        targetType: "integration",
        targetId: cur.id,
        // トークンそのものは記録しない
        detail: {
          label: updated.label,
          before: { label: cur.label, config: cur.config },
          after: { label: updated.label, config: updated.config },
          tokenChanged: Boolean(input.token),
        },
      });
      return c.json(publicIntegration(updated));
    });

    app.delete("/api/orgs/:orgId/integrations/:id", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "integration.manage");
      const cur = await findIntegration(orgId, c.req.param("id"));
      await store.deleteIntegration(orgId, cur.id);
      await audit(store, {
        orgId,
        actor: ctx.actorOf(c),
        action: "integration.delete",
        targetType: "integration",
        targetId: cur.id,
        detail: { kind: cur.kind, label: cur.label, config: cur.config },
      });
      return c.body(null, 204);
    });

    /** 接続確認（トークンでリポジトリ・プロジェクトを読めるか） */
    app.post("/api/orgs/:orgId/integrations/:id/test", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "integration.manage");
      const i = await findIntegration(orgId, c.req.param("id"));
      const secret = await ctx.encryptor.decrypt(i.encryptedSecret, { orgId });
      try {
        return c.json({ ok: true, message: await checkIntegration(i.kind, i.config, secret, ctx.fetchImpl) });
      } catch (e) {
        if (e instanceof IntegrationError) return c.json({ ok: false, message: e.message });
        throw e;
      }
    });

    // タスク分解
    app.get("/api/projects/:id/tasks", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      const rec = await store.latestTaskPlan(p.id);
      return c.json(rec ? await planView(rec, await store.listRequirements(p.id), p.orgId) : null);
    });

    app.post("/api/projects/:id/tasks/generate", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "requirements.edit");
      if (jobs.wantsAsync(c)) {
        if (!(await store.listRequirements(p.id)).some((r) => TASK_TARGET_TYPES.includes(r.type))) {
          throw new HTTPException(400, { message: "機能要件・非機能要件がまだありません。ヒアリングで要件を確定してから分解してください" });
        }
        await ctx.budget(p.orgId, []);
        return jobs.enqueue(c, p, "tasks", {});
      }
      return c.json(await executeTasks(p, ctx.actorOf(c)), 201);
    });

    /** 分解結果のファイル出力（md / jira.csv / backlog.csv / json） */
    const FILES = {
      md: { type: "text/markdown; charset=utf-8", ext: "md" },
      "jira.csv": { type: "text/csv; charset=utf-8", ext: "jira.csv" },
      "backlog.csv": { type: "text/csv; charset=utf-8", ext: "backlog.csv" },
      json: { type: "application/json; charset=utf-8", ext: "json" },
    } as const;
    app.get("/api/projects/:id/tasks/file/:format", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "export");
      const format = c.req.param("format") as keyof typeof FILES;
      if (!(format in FILES)) throw new HTTPException(400, { message: `形式が正しくありません: ${format}` });
      const rec = await planOf(p, c.req.query("planId") || undefined);
      const reqs = toTaskReqs(await store.listRequirements(p.id));
      // 表計算ソフト（Excel）で文字化けしないよう、CSVにはBOMを付ける
      const text =
        format === "md"
          ? toTaskMarkdown(rec.plan, p.name, reqs)
          : format === "jira.csv"
            ? `﻿${toJiraCsv(rec.plan, reqs)}`
            : format === "backlog.csv"
              ? `﻿${toBacklogCsv(rec.plan, reqs)}`
              : JSON.stringify({ project: p.name, createdAt: rec.createdAt, ...rec.plan }, null, 2);
      const utf8 = encodeURIComponent(`${p.name}_実装タスク.${FILES[format].ext}`);
      return c.body(text, 200, {
        "content-type": FILES[format].type,
        "content-disposition": `attachment; filename="tasks.${FILES[format].ext}"; filename*=UTF-8''${utf8}`,
      });
    });

    /** 課題管理ツールへの登録（登録済みのものは飛ばす） */
    app.post("/api/projects/:id/tasks/register", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "tasks.publish");
      const input = await ctx.body(c, RegisterInput);
      if (jobs.wantsAsync(c)) {
        await validateRegister(p, input);
        return jobs.enqueue(c, p, "export", input);
      }
      return c.json(await executeRegister(p, input, ctx.actorOf(c)), 201);
    });

    app.get("/api/projects/:id/tasks/exports", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      const rec = await store.latestTaskPlan(p.id);
      return c.json(rec ? await store.listTaskExports(rec.id) : []);
    });

    app.get("/api/projects/:id/trace", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      return c.json(await trace(p));
    });
  }

  return {
    routes,
    jobHandlers: {
      tasks: (p: Project, _input: unknown, actor: string, report: (pr: JobProgress) => Promise<void>) => executeTasks(p, actor, report),
      export: (p: Project, input: unknown, actor: string, report: (pr: JobProgress) => Promise<void>) =>
        executeRegister(p, ctx.parseOrThrow(RegisterInput, input), actor, report),
    },
  };
}
