/**
 * チームで使うための機能
 * - 要件へのコメント（相談・指摘。解決済みにできる）
 * - プロジェクト単位のメンバー（入っている人だけが見られる。プロジェクトでの役割）
 * - プロジェクトの複製・書き出し（JSON）・書き出したファイルからの取り込み
 */
import { AcceptanceCriteria, BusinessRule, Ears, GlossaryTerm, RequirementType, UmlModel } from "@arn/ai-core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Principal, Role } from "./auth.js";
import type { AnyContext, ImplementationContext } from "./implementation.js";
import { checkAiConfig } from "./org-admin.js";
import type { Permission } from "./permissions.js";
import type { AIConfig, GlossarySheet, ImportedRequirement, OrgMember, Project, ProjectAccess, Requirement, RequirementComment, Store } from "./store.js";

export interface CollabOptions {
  /** プロジェクトで持つ役割と権限（見られなければ null）。app.ts の loadProject と同じ決まり */
  accessOf: (pr: Principal, p: Project) => Promise<{ role: Role; permissions: Permission[]; restricted: boolean } | null>;
  memberOf: (pr: Principal, orgId: string) => Promise<OrgMember | null>;
  /** 模擬AI を使ってよいか（取り込み時の AI の構成を決めるため） */
  allowMock: boolean;
}

const ROLE_JA: Record<Role, string> = { admin: "管理者", editor: "編集者", reviewer: "レビュー担当", viewer: "閲覧者" };

const CommentInput = z.object({ body: z.string().trim().min(1, "コメントを入れてください").max(4000) }).strict();
const CommentPatchInput = z
  .object({
    body: z.string().trim().min(1).max(4000).optional(),
    /** true: 解決済みにする / false: 未解決に戻す */
    resolved: z.boolean().optional(),
  })
  .strict();
const AccessInput = z
  .object({
    restricted: z.boolean(),
    members: z.array(z.object({ memberId: z.string().min(1), role: z.enum(["editor", "reviewer", "viewer"]) }).strict()).max(500),
  })
  .strict();
const DuplicateInput = z.object({ name: z.string().trim().min(1).max(200).optional(), includeMembers: z.boolean().default(true) }).strict();

/* ------------------------------------------------------------------ */
/* 書き出しの形（arn-project/1）                                         */
/* ------------------------------------------------------------------ */

export const BUNDLE_FORMAT = "arn-project/1";
const CODE = /^(BR|AC|FR|RL|NFR|CN)-(\d{1,4})$/;
const BundleRequirement = z.object({
  code: z.string().regex(CODE, "要件の番号の形式が正しくありません（例: FR-01）"),
  type: RequirementType,
  title: z.string().max(2000).default(""),
  description: z.string().max(5000).default(""),
  priority: z.enum(["must", "should", "could"]).default("should"),
  phaseKey: z.string().max(40).nullable().default(null),
  source: z.string().max(200).default(""),
  version: z.number().int().min(1).max(100_000).default(1),
  ears: Ears.nullable().default(null),
  rule: BusinessRule.nullable().default(null),
  /** 削除済み（番号を再利用しないため、欠番として持つ） */
  deleted: z.boolean().default(false),
});
const BundleNfrDecision = z.object({
  status: z.enum(["undecided", "decided", "na", "deferred"]),
  level: z.string().max(20).nullable().default(null),
  value: z.string().max(200).default(""),
  rationale: z.string().max(1000).default(""),
  owner: z.string().max(100).default(""),
  /** この項目から作った要件の番号（ID は取り込み先で変わるため番号で持つ） */
  requirementCode: z.string().regex(CODE).nullable().default(null),
});
export const ProjectBundle = z.object({
  format: z.literal(BUNDLE_FORMAT, { message: `要件ナビで書き出したファイル（${BUNDLE_FORMAT}）ではありません` }),
  exportedAt: z.string().max(40).optional(),
  project: z.object({
    name: z.string().min(1).max(200),
    purpose: z.string().max(2000).default(""),
    confidential: z.boolean().default(false),
    phaseKey: z.string().max(40).default("purpose"),
    settings: z.object({ approvalRequired: z.boolean().optional(), requiredApprovals: z.number().int().min(1).max(20).optional() }).default({}),
    aiConfig: z.object({ mode: z.enum(["single", "review", "multi"]), generatorIds: z.array(z.string().max(100)).max(4), evaluatorId: z.string().max(100).nullable() }).nullable().default(null),
  }),
  requirements: z.array(BundleRequirement).max(5000).default([]),
  glossary: z.object({ terms: z.array(GlossaryTerm).max(2000) }).nullable().default(null),
  acceptance: AcceptanceCriteria.nullable().default(null),
  nfr: z
    .object({
      profile: z.record(z.string().max(40), z.union([z.literal(0), z.literal(1), z.literal(2)])),
      decisions: z.record(z.string().max(60), BundleNfrDecision),
    })
    .nullable()
    .default(null),
  documents: z
    .array(z.object({ name: z.string().min(1).max(200), kind: z.string().max(40).default("other"), format: z.string().max(20).default("text"), text: z.string().max(400_000), truncated: z.boolean().default(false) }))
    .max(100)
    .default([]),
  comments: z
    .array(
      z.object({
        requirementCode: z.string().regex(CODE),
        body: z.string().min(1).max(4000),
        authorName: z.string().max(200).default(""),
        status: z.enum(["open", "resolved"]).default("open"),
        createdAt: z.string().max(40).optional(),
      }),
    )
    .max(20_000)
    .default([]),
  /** 採用した UML（取り込み時も使う） */
  uml: UmlModel.nullable().default(null),
  /** 画面一覧とタスク分解（参照用。取り込み時は作り直してもらう） */
  screens: z.unknown().optional(),
  taskPlan: z.unknown().optional(),
});
export type ProjectBundle = z.infer<typeof ProjectBundle>;

export function collaboration(ctx: ImplementationContext, opts: CollabOptions) {
  const { store } = ctx;
  const principal = (c: AnyContext) => c.get("principal") as Principal;

  /** プロジェクトの中で、その権限を持つか */
  const has = async (c: AnyContext, p: Project, perm: Permission) => Boolean((await opts.accessOf(principal(c), p))?.permissions.includes(perm));
  const nameOf = async (c: AnyContext, orgId: string) => {
    const pr = principal(c);
    if (pr.name) return pr.name;
    const m = await opts.memberOf(pr, orgId);
    return m?.name || m?.email || pr.userId;
  };
  const loadComment = async (c: AnyContext, id: string) => {
    const m = await store.getComment(id);
    if (!m) throw new HTTPException(404, { message: "コメントが見つかりません" });
    const p = await ctx.loadProject(c, m.projectId, "project.view");
    return { m, p };
  };
  const publicComment = (c: AnyContext, m: RequirementComment) => ({ ...m, mine: m.authorId === ctx.actorOf(c) });

  /* ---------- 書き出し・取り込み ---------- */

  /** プロジェクトの中身を、書き出しの形にする（ID は持たず、要件は番号で結ぶ） */
  async function bundleOf(p: Project): Promise<ProjectBundle & { screens?: unknown; taskPlan?: unknown }> {
    const all = await allRequirements(store, p.id);
    const codeOf = new Map(all.map((r) => [r.id, r.code]));
    const [glossary, acceptance, nfr, docs, comments, uml, screens, plan] = await Promise.all([
      store.getProjectSheet<GlossarySheet>(p.id, "glossary"),
      store.getProjectSheet<z.infer<typeof AcceptanceCriteria>>(p.id, "acceptance"),
      store.getNfrSheet(p.id),
      store.listDocuments(p.id),
      store.listComments(p.id),
      store.latestUmlModel(p.id),
      store.latestScreens(p.id),
      store.latestTaskPlan(p.id),
    ]);
    return {
      format: BUNDLE_FORMAT,
      exportedAt: new Date().toISOString(),
      project: { name: p.name, purpose: p.purpose, confidential: p.confidential, phaseKey: p.phaseKey, settings: p.settings ?? {}, aiConfig: p.aiConfig },
      requirements: all.map((r) => ({
        code: r.code,
        type: r.type,
        title: r.deletedAt ? "" : r.title,
        description: r.deletedAt ? "" : r.description,
        priority: r.priority,
        phaseKey: r.phaseKey,
        source: r.source,
        version: r.version,
        ears: r.deletedAt ? null : r.ears,
        rule: r.deletedAt ? null : (r.rule ?? null),
        deleted: Boolean(r.deletedAt),
      })),
      glossary: glossary?.data ?? null,
      acceptance: acceptance?.data ?? null,
      nfr: nfr
        ? {
            profile: nfr.profile as Record<string, 0 | 1 | 2>,
            decisions: Object.fromEntries(
              Object.entries(nfr.decisions).map(([k, d]) => [k, { status: d.status, level: d.level, value: d.value, rationale: d.rationale, owner: d.owner, requirementCode: (d.requirementId && codeOf.get(d.requirementId)) || null }]),
            ),
          }
        : null,
      documents: docs.map((d) => ({ name: d.name, kind: d.kind, format: d.format, text: d.text, truncated: d.truncated })),
      comments: comments
        .filter((m) => codeOf.has(m.requirementId))
        .map((m) => ({ requirementCode: codeOf.get(m.requirementId)!, body: m.body, authorName: m.authorName, status: m.status, createdAt: m.createdAt })),
      uml: uml?.model ?? null,
      screens: screens ? { model: screens.model, basis: screens.basis } : undefined,
      taskPlan: plan ? { plan: plan.plan, basis: plan.basis } : undefined,
    };
  }

  /** 書き出しの形から、新しいプロジェクトを作る */
  async function restore(
    orgId: string,
    b: ProjectBundle,
    o: { name: string; aiConfig: AIConfig; access: ProjectAccess | null; actor: string; generated?: { screens?: unknown; taskPlan?: unknown; providerId: string } },
  ) {
    const project = await store.createProject({ orgId, name: o.name, purpose: b.project.purpose, confidential: b.project.confidential, aiConfig: o.aiConfig });
    if (b.project.phaseKey && b.project.phaseKey !== project.phaseKey) await store.setProjectPhase(project.id, b.project.phaseKey);
    if (Object.keys(b.project.settings).length) await store.updateProjectSettings(project.id, b.project.settings);
    if (o.access) await store.updateProjectAccess(project.id, o.access);
    const rows: ImportedRequirement[] = b.requirements.map((r) => ({
      code: r.code,
      type: r.type,
      title: r.deleted ? "（削除済み）" : r.title || "（内容なし）",
      description: r.description,
      priority: r.priority,
      phaseKey: r.phaseKey,
      source: r.source,
      version: r.version,
      ears: r.ears,
      rule: r.rule,
      deletedAt: r.deleted ? new Date().toISOString() : null,
    }));
    const added = await store.importRequirements(project.id, rows);
    const idOf = new Map(added.map((r) => [r.code, r]));
    if (b.glossary) await store.saveProjectSheet(project.id, "glossary", b.glossary, o.actor);
    if (b.acceptance) await store.saveProjectSheet(project.id, "acceptance", b.acceptance, o.actor);
    if (b.nfr) {
      const decisions = Object.fromEntries(
        Object.entries(b.nfr.decisions).map(([k, d]) => [k, { status: d.status, level: d.level, value: d.value, rationale: d.rationale, owner: d.owner, requirementId: (d.requirementCode && idOf.get(d.requirementCode)?.id) || null }]),
      );
      await store.saveNfrSheet({ projectId: project.id, profile: b.nfr.profile, decisions, suggestions: null, review: null });
    }
    for (const d of b.documents) {
      await store.addDocument({ projectId: project.id, name: d.name, kind: d.kind, format: d.format, text: d.text, chars: d.text.length, truncated: d.truncated, createdBy: o.actor });
    }
    let comments = 0;
    for (const m of b.comments) {
      const r = idOf.get(m.requirementCode);
      if (!r) continue;
      await store.addComment({
        projectId: project.id,
        requirementId: r.id,
        requirementCode: r.code,
        body: m.body,
        authorId: o.actor,
        authorName: m.authorName ? `${m.authorName}（取り込み）` : "（取り込み）",
        status: m.status,
        resolvedBy: m.status === "resolved" ? o.actor : null,
        resolvedAt: m.status === "resolved" ? new Date().toISOString() : null,
      });
      comments++;
    }
    const providerId = o.generated?.providerId ?? o.aiConfig.generatorIds[0] ?? "";
    if (b.uml) await store.saveUmlModel(project.id, b.uml, providerId);
    // 画面・タスク分解は同じサーバーの中の複製だけ写す（ファイルからは取り込まない）
    const g = o.generated as { screens?: { model: never; basis: Array<{ code: string; version: number }> }; taskPlan?: { plan: never; basis: Array<{ code: string; version: number }> } } | undefined;
    if (g?.screens) await store.saveScreens({ projectId: project.id, model: g.screens.model, providerId, basis: g.screens.basis, revision: 1, createdBy: o.actor });
    if (g?.taskPlan) await store.saveTaskPlan({ projectId: project.id, plan: g.taskPlan.plan, providerId, basis: g.taskPlan.basis, createdBy: o.actor });
    return {
      project: (await store.getProject(project.id))!,
      counts: { requirements: added.length, documents: b.documents.length, comments, glossary: b.glossary?.terms.length ?? 0, uml: Boolean(b.uml), screens: Boolean(g?.screens), tasks: Boolean(g?.taskPlan) },
    };
  }

  /** 取り込み先の組織で使う AI の構成（書き出し元の構成が使えなければ、登録済みの AI から決める） */
  async function aiConfigFor(orgId: string, wanted: ProjectBundle["project"]["aiConfig"], confidential: boolean): Promise<{ aiConfig: AIConfig; replaced: boolean }> {
    if (wanted) {
      try {
        return { aiConfig: await checkAiConfig(store, orgId, wanted, confidential), replaced: false };
      } catch {
        /* 使えない（別の組織の AI など）→ 登録済みの AI から決める */
      }
    }
    const creds = (await store.listCredentials(orgId)).filter((x) => (x.vendor !== "mock" || opts.allowMock) && (!confidential || x.isLocal));
    if (!creds.length) {
      throw new HTTPException(400, { message: confidential ? "機密プロジェクトです。先に「AI設定」でローカルLLMを登録してください" : "先に「AI設定」でAIを登録してください" });
    }
    const ids = creds.map((x) => x.id);
    const aiConfig: AIConfig = ids.length >= 2 ? { mode: "multi", generatorIds: ids.slice(0, 2), evaluatorId: ids[2] ?? null } : { mode: "single", generatorIds: ids.slice(0, 1), evaluatorId: null };
    return { aiConfig, replaced: true };
  }

  function routes(app: Hono<any>) {
    /* ---------- 要件へのコメント ---------- */

    /** プロジェクトのコメント（古い順）。requirementId で要件を絞れる */
    app.get("/api/projects/:id/comments", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      const rid = c.req.query("requirementId");
      const list = (await store.listComments(p.id)).filter((m) => !rid || m.requirementId === rid);
      return c.json(list.map((m) => publicComment(c, m)));
    });

    app.post("/api/requirements/:id/comments", async (c) => {
      const r = await store.getRequirement(c.req.param("id"));
      if (!r || r.deletedAt) throw new HTTPException(404, { message: "要件が見つかりません" });
      const p = await ctx.loadProject(c, r.projectId, "comment.write");
      const { body } = await ctx.body(c, CommentInput);
      const m = await store.addComment({
        projectId: p.id,
        requirementId: r.id,
        requirementCode: r.code,
        body,
        authorId: ctx.actorOf(c),
        authorName: await nameOf(c, p.orgId),
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
      });
      // 本文は個人の意見を含むことがあるため、監査ログには長さだけを残す
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "comment.create", targetType: "comment", targetId: m.id, detail: { requirement: r.code, chars: body.length } });
      return c.json(publicComment(c, m), 201);
    });

    /** 本文の直し（書いた本人だけ）・解決済みにする／戻す（コメントの権限を持つ人） */
    app.patch("/api/comments/:id", async (c) => {
      const { m, p } = await loadComment(c, c.req.param("id"));
      const input = await ctx.body(c, CommentPatchInput);
      if (input.body === undefined && input.resolved === undefined) throw new HTTPException(400, { message: "変更する項目がありません" });
      if (!(await has(c, p, "comment.write"))) throw new HTTPException(403, { message: "この操作には「要件へのコメント」の権限が必要です" });
      const mine = m.authorId === ctx.actorOf(c);
      if (input.body !== undefined && !mine) throw new HTTPException(403, { message: "コメントの本文は、書いた本人だけが直せます" });
      const patch: Parameters<Store["updateComment"]>[1] = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.resolved !== undefined) {
        patch.status = input.resolved ? "resolved" : "open";
        patch.resolvedBy = input.resolved ? ctx.actorOf(c) : null;
        patch.resolvedAt = input.resolved ? new Date().toISOString() : null;
      }
      const u = await store.updateComment(m.id, patch);
      if (!u) throw new HTTPException(404, { message: "コメントが見つかりません" });
      const action = input.resolved === undefined ? "comment.update" : input.resolved ? "comment.resolve" : "comment.reopen";
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action, targetType: "comment", targetId: m.id, detail: { requirement: m.requirementCode, ...(input.body !== undefined ? { chars: input.body.length } : {}) } });
      return c.json(publicComment(c, u));
    });

    /** 削除（書いた本人か、プロジェクトの管理の権限を持つ人） */
    app.delete("/api/comments/:id", async (c) => {
      const { m, p } = await loadComment(c, c.req.param("id"));
      const mine = m.authorId === ctx.actorOf(c) && (await has(c, p, "comment.write"));
      if (!mine && !(await has(c, p, "project.manage"))) throw new HTTPException(403, { message: "コメントを消せるのは、書いた本人とプロジェクトの管理者だけです" });
      await store.deleteComment(m.id);
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "comment.delete", targetType: "comment", targetId: m.id, detail: { requirement: m.requirementCode, author: m.authorName, mine: m.authorId === ctx.actorOf(c) } });
      return c.body(null, 204);
    });

    /* ---------- プロジェクトのメンバー ---------- */

    app.get("/api/projects/:id/members", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      const all = await store.listMembers(p.orgId);
      const byId = new Map(all.map((m) => [m.id, m]));
      const manage = await has(c, p, "project.manage");
      const access = p.access ?? { restricted: false, members: [] };
      return c.json({
        restricted: access.restricted,
        canManage: manage,
        members: access.members
          .map((x) => ({ x, m: byId.get(x.memberId) }))
          .filter(({ m }) => m && m.status !== "removed")
          .map(({ x, m }) => ({ memberId: x.memberId, role: x.role, roleName: ROLE_JA[x.role], name: m!.name, email: m!.email, orgRole: m!.role, status: m!.status })),
        // 選べる人（組織のメンバー。管理者はいつでも見られるため除く）。メンバーを決められる人にだけ返す
        candidates: manage
          ? all.filter((m) => m.status !== "removed" && m.role !== "admin").map((m) => ({ memberId: m.id, name: m.name, email: m.email, orgRole: m.role, status: m.status }))
          : [],
        admins: all.filter((m) => m.status === "active" && m.role === "admin").map((m) => ({ name: m.name, email: m.email })),
      });
    });

    app.put("/api/projects/:id/members", async (c) => {
      const p0 = await ctx.loadProject(c, c.req.param("id"), "project.manage");
      // 変更前の値（記録用）。保存先によっては同じオブジェクトが書き換わるため、先に写しを取る
      const before = structuredClone(p0.access ?? null);
      const input = await ctx.body(c, AccessInput);
      const all = new Map((await store.listMembers(p0.orgId)).map((m) => [m.id, m]));
      const seen = new Set<string>();
      const members: ProjectAccess["members"] = [];
      for (const x of input.members) {
        const m = all.get(x.memberId);
        if (!m || m.status === "removed") throw new HTTPException(400, { message: `組織のメンバーではありません: ${x.memberId}` });
        if (m.role === "admin") throw new HTTPException(400, { message: `${m.name || m.email} は組織の管理者のため、メンバーに入れなくても見られます` });
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        members.push({ memberId: m.id, role: x.role });
      }
      const pr = principal(c);
      if (input.restricted && pr.role !== "admin") {
        // 自分を外すと、このプロジェクトを開けなくなる
        const me = await opts.memberOf(pr, p0.orgId);
        if (!me || !seen.has(me.id)) throw new HTTPException(409, { message: "あなた自身がメンバーに入っていないため、保存するとこのプロジェクトを開けなくなります。自分をメンバーに入れてください" });
      }
      const access: ProjectAccess | null = input.restricted || members.length ? { restricted: input.restricted, members } : null;
      const u = await store.updateProjectAccess(p0.id, access);
      if (!u) throw new HTTPException(404, { message: "プロジェクトが見つかりません" });
      const view = (a: ProjectAccess | null) => ({ restricted: Boolean(a?.restricted), members: (a?.members ?? []).map((x) => ({ email: all.get(x.memberId)?.email ?? x.memberId, role: x.role })) });
      await audit(store, { orgId: p0.orgId, actor: ctx.actorOf(c), action: "project.members", targetType: "project", targetId: p0.id, detail: { name: p0.name, before: view(before), after: view(access) } });
      return c.json({ restricted: Boolean(access?.restricted), members: access?.members ?? [] });
    });

    /* ---------- 複製・書き出し・取り込み ---------- */

    /** 書き出し（JSON）。バックアップや、別の環境・組織への移行に使う。API キーや利用者の情報は入れない */
    app.get("/api/projects/:id/export.json", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "export");
      const b = await bundleOf(p);
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "project.export", targetType: "project", targetId: p.id, detail: { name: p.name, requirements: b.requirements.length, documents: b.documents.length, comments: b.comments.length } });
      const utf8 = encodeURIComponent(`${p.name}_要件ナビ.json`);
      return c.body(JSON.stringify(b, null, 2), 200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="project.json"; filename*=UTF-8''${utf8}`,
      });
    });

    /** 複製（同じ組織に、名前を変えて新しいプロジェクトを作る。履歴は写さない） */
    app.post("/api/projects/:id/duplicate", async (c) => {
      const src = await ctx.loadProject(c, c.req.param("id"), "project.view");
      ctx.need(c, src.orgId, "project.create");
      const input = await ctx.body(c, DuplicateInput);
      const b = await bundleOf(src);
      const { aiConfig } = await aiConfigFor(src.orgId, src.aiConfig, src.confidential);
      const pr = principal(c);
      let access = input.includeMembers && src.access ? structuredClone(src.access) : null;
      // 管理者でない人が複製したら、自分を編集者として入れる（作った人が開けなくならないように）
      if (access?.restricted && pr.role !== "admin") {
        const me = await opts.memberOf(pr, src.orgId);
        if (me && !access.members.some((x) => x.memberId === me.id)) access.members.push({ memberId: me.id, role: "editor" });
        else if (me) access.members = access.members.map((x) => (x.memberId === me.id ? { ...x, role: "editor" } : x));
      }
      if (access && !access.restricted && !access.members.length) access = null;
      const r = await restore(src.orgId, ParseBundle(b), {
        name: input.name ?? `${src.name}（コピー）`,
        aiConfig,
        access,
        actor: ctx.actorOf(c),
        generated: { screens: b.screens, taskPlan: b.taskPlan, providerId: aiConfig.generatorIds[0]! },
      });
      await audit(store, { orgId: src.orgId, actor: ctx.actorOf(c), action: "project.duplicate", targetType: "project", targetId: r.project.id, detail: { name: r.project.name, from: { id: src.id, name: src.name }, counts: r.counts } });
      return c.json(r, 201);
    });

    /** 書き出したファイルから、新しいプロジェクトとして取り込む */
    app.post("/api/orgs/:orgId/projects/import", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "project.create");
      const input = await ctx.body(c, z.object({ data: z.unknown(), name: z.string().trim().min(1).max(200).optional() }).strict());
      const b = ParseBundle(input.data);
      const { aiConfig, replaced } = await aiConfigFor(orgId, b.project.aiConfig, b.project.confidential);
      const r = await restore(orgId, b, { name: input.name ?? b.project.name, aiConfig, access: null, actor: ctx.actorOf(c) });
      const notes: string[] = [];
      if (replaced) notes.push("書き出し元の AI はこの組織にないため、登録済みの AI を使うようにしました（「プロジェクト設定」で変えられます）");
      if (b.screens || b.taskPlan) notes.push("画面とタスク分解は取り込みません。必要なら作り直してください");
      if (b.comments.length) notes.push("コメントは、書いた人の名前に「（取り込み）」を付けて残しました");
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "project.import", targetType: "project", targetId: r.project.id, detail: { name: r.project.name, counts: r.counts, exportedAt: b.exportedAt ?? null } });
      return c.json({ ...r, notes }, 201);
    });
  }

  /** 番号の重複・区分との食い違いを確かめる */
  function ParseBundle(raw: unknown): ProjectBundle {
    const r = ProjectBundle.safeParse(raw);
    if (!r.success) {
      const i = r.error.issues[0]!;
      throw new HTTPException(400, { message: `書き出したファイルの形式が正しくありません（${i.path.join(".") || "全体"}: ${i.message}）` });
    }
    const codes = new Set<string>();
    for (const q of r.data.requirements) {
      if (codes.has(q.code)) throw new HTTPException(400, { message: `要件の番号が重なっています: ${q.code}` });
      if (CODE.exec(q.code)![1] !== q.type) throw new HTTPException(400, { message: `要件の番号と区分が合いません: ${q.code}（区分 ${q.type}）` });
      if (!q.deleted && !q.title.trim()) throw new HTTPException(400, { message: `要件の内容が空です: ${q.code}` });
      codes.add(q.code);
    }
    return r.data;
  }

  return { routes, bundleOf };
}

/** 削除済みを含むすべての要件（欠番を残し、取り込み先で番号を再利用しないため） */
const allRequirements = (store: Store, projectId: string): Promise<Requirement[]> => store.listRequirements(projectId, { includeDeleted: true });
