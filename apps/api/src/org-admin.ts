/**
 * 組織の管理: メンバーと役割・組織の基本情報・プロジェクトの整理。
 *
 * メンバーと役割は要件ナビで管理する（ログインの仕組み Cognito / Keycloak は本人確認だけ）。
 * - 管理者がメールアドレスで招待し、役割を決める。招待された人がログインすると、確認済みのメールアドレスで結び付ける
 * - 1人で複数の組織に入れる（画面で組織を切り替える。リクエストの x-org-id で選ぶ）
 * - 以前の運用（トークンの組織・役割のクレーム）で入った人は、最初のログインでメンバーとして登録し、以後は画面の設定に従う
 * - 「外した」人は、クレームがあっても入れない
 * - 管理者が1人もいなくなる変更（最後の管理者の役割変更・外す）はできない
 * 開発用ログイン（AUTH_MODE=dev）では、組織と役割は画面右上で選ぶため、メンバーの設定は使わない（一覧と招待は試せる）。
 */
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import { ROLES, type Principal, type Role } from "./auth.js";
import type { AnyContext, ImplementationContext } from "./implementation.js";
import type { OrgMember, Project, Store } from "./store.js";

const RoleSchema = z.enum(["admin", "editor", "reviewer", "viewer"]);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "メールアドレスの形式が正しくありません");
const InviteInput = z.object({ email, role: RoleSchema, name: z.string().trim().max(100).optional() });
const MemberPatchInput = z.object({ role: RoleSchema.optional(), name: z.string().trim().max(100).optional() }).strict();
const OrgPatchInput = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const ProjectPatchInput = z
  .object({ name: z.string().trim().min(1).max(200).optional(), purpose: z.string().max(2000).optional(), archived: z.boolean().optional() })
  .strict();
const ProjectDeleteInput = z.object({ confirmName: z.string() });

/** 最後に使った日時を記録する間隔（毎回は書かない） */
const SEEN_INTERVAL_MS = 10 * 60_000;

/**
 * ログインした人の組織と役割を、組織のメンバーから決める（ログイン画面のとき）。
 * wanted: 使いたい組織（画面で選んだ組織。x-org-id）
 */
export async function resolveMember(store: Store, p: Principal, wanted: string | undefined, now = new Date()): Promise<Principal & { memberships: OrgMember[] }> {
  const verifiedEmail = p.emailVerified && p.email ? p.email : undefined;
  let ms = await store.findMemberships({ sub: p.userId, email: verifiedEmail });
  // 招待を本人に結び付ける（確認済みのメールアドレスが一致したとき）
  for (const m of ms) {
    if (m.status === "invited" && !m.userSub && verifiedEmail && m.email === verifiedEmail) {
      const u = await store.updateMember(m.orgId, m.id, { userSub: p.userId, status: "active", name: m.name || p.name || "", lastSeenAt: now.toISOString() });
      if (u) Object.assign(m, u);
    }
  }
  // 以前の運用: トークンのクレームで組織・役割が決まる人は、その組織のメンバーとして登録する（一度だけ）
  if (p.fromClaims && p.orgId && !ms.some((m) => m.orgId === p.orgId) && (await store.getOrg(p.orgId))) {
    try {
      ms = [...ms, await store.addMember({ orgId: p.orgId, email: verifiedEmail ?? "", userSub: p.userId, name: p.name ?? "", role: p.role, status: "active", source: "idp", invitedBy: null, lastSeenAt: now.toISOString() })];
    } catch {
      ms = await store.findMemberships({ sub: p.userId, email: verifiedEmail });
    }
  }
  const usable = ms.filter((m) => m.status === "active" && m.userSub === p.userId);
  const target = wanted || (p.fromClaims ? p.orgId : "") || (usable.length === 1 ? usable[0]!.orgId : "");
  const m = usable.find((x) => x.orgId === target);
  if (!m) return { ...p, orgId: "", role: "viewer", memberships: ms };
  if (!m.lastSeenAt || now.getTime() - Date.parse(m.lastSeenAt) > SEEN_INTERVAL_MS) {
    await store.updateMember(m.orgId, m.id, { lastSeenAt: now.toISOString(), ...(p.name && !m.name ? { name: p.name } : {}) });
  }
  return { ...p, orgId: m.orgId, role: m.role, memberships: ms };
}

const publicMember = (m: OrgMember) => ({
  id: m.id,
  email: m.email,
  name: m.name,
  role: m.role,
  status: m.status,
  source: m.source,
  invitedBy: m.invitedBy,
  lastSeenAt: m.lastSeenAt,
  createdAt: m.createdAt,
  linked: Boolean(m.userSub),
});

export interface OrgAdminOptions {
  devAuth: boolean;
  publicUrl?: string;
  /** 今月の利用量（組織全体） */
  usageOf: (orgId: string) => Promise<{ month: string; used: number; limit: number | null }>;
}

export function orgAdmin(ctx: ImplementationContext, opts: OrgAdminOptions) {
  const { store } = ctx;
  const principal = (c: AnyContext) => c.get("principal") as Principal & { memberships?: OrgMember[] };

  /** 管理者が1人もいなくならないか */
  const assertAdminRemains = async (orgId: string, changing: OrgMember, next: { role?: Role; removed?: boolean }) => {
    if (changing.role !== "admin" || changing.status !== "active") return;
    if (!next.removed && (next.role ?? "admin") === "admin") return;
    const admins = (await store.listMembers(orgId)).filter((m) => m.role === "admin" && m.status === "active");
    if (admins.length <= 1) throw new HTTPException(409, { message: "組織の管理者が1人もいなくなるため、変更できません。先にほかの人を管理者にしてください" });
  };

  const loginUrl = (c: Context) => (opts.publicUrl ? opts.publicUrl.replace(/\/+$/, "") : new URL(c.req.url).origin) + "/";

  function routes(app: Hono<any>) {
    /** ログインしている人と、入っている組織 */
    app.get("/api/me", async (c) => {
      const p = principal(c);
      if (opts.devAuth) return c.json({ userId: p.userId, orgId: p.orgId, role: p.role, dev: true, orgs: [] });
      const ms = (p.memberships ?? []).filter((m) => m.status === "active" && m.userSub === p.userId);
      const orgs = await Promise.all(ms.map(async (m) => ({ orgId: m.orgId, name: (await store.getOrg(m.orgId))?.name ?? "", role: m.role })));
      const invited = (p.memberships ?? []).filter((m) => m.status === "invited").length;
      return c.json({ userId: p.userId, email: p.email ?? null, name: p.name ?? null, orgId: p.orgId, role: p.role, dev: false, orgs, invitedPending: invited });
    });

    /** 組織の概要（名前・メンバー・AI・連携先・プロジェクトの数・今月の利用量） */
    app.get("/api/orgs/:orgId/summary", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "viewer");
      const org = await store.getOrg(orgId);
      if (!org) throw new HTTPException(404, { message: "見つかりません" });
      const [members, providers, integrations, projects, usage] = await Promise.all([
        store.listMembers(orgId),
        store.listCredentials(orgId),
        store.listIntegrations(orgId),
        store.listProjects(orgId),
        opts.usageOf(orgId),
      ]);
      return c.json({
        org: { id: org.id, name: org.name, createdAt: org.createdAt, monthlyTokenLimit: org.monthlyTokenLimit },
        counts: {
          members: { active: members.filter((m) => m.status === "active").length, invited: members.filter((m) => m.status === "invited").length, admins: members.filter((m) => m.status === "active" && m.role === "admin").length },
          providers: providers.length,
          integrations: integrations.length,
          projects: { active: projects.filter((p) => !p.archivedAt).length, archived: projects.filter((p) => p.archivedAt).length },
        },
        usage,
        memberManagement: opts.devAuth ? "dev" : "app",
      });
    });

    /** 組織名の変更 */
    app.patch("/api/orgs/:orgId", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, OrgPatchInput);
      const before = await store.getOrg(orgId);
      const org = await store.renameOrg(orgId, input.name);
      if (!org || !before) throw new HTTPException(404, { message: "見つかりません" });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "org.update", targetType: "org", targetId: orgId, detail: { before: { name: before.name }, after: { name: org.name } } });
      return c.json(org);
    });

    /* ---------- メンバー ---------- */
    app.get("/api/orgs/:orgId/members", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const list = (await store.listMembers(orgId)).filter((m) => m.status !== "removed" || c.req.query("removed") === "1");
      const order = { active: 0, invited: 1, removed: 2 } as const;
      list.sort((a, b) => order[a.status] - order[b.status] || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.createdAt.localeCompare(b.createdAt));
      return c.json({ members: list.map(publicMember), loginUrl: loginUrl(c), management: opts.devAuth ? "dev" : "app" });
    });

    app.post("/api/orgs/:orgId/members", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, InviteInput);
      const cur = (await store.listMembers(orgId)).find((m) => m.email === input.email);
      let m: OrgMember | null;
      if (cur && cur.status !== "removed") throw new HTTPException(409, { message: `${input.email} はすでに${cur.status === "invited" ? "招待しています" : "メンバーです"}` });
      if (cur) {
        // 外した人を招待し直す（ログインしたことがあれば、そのまま使える）
        m = await store.updateMember(orgId, cur.id, { role: input.role, status: cur.userSub ? "active" : "invited", ...(input.name ? { name: input.name } : {}) });
      } else {
        m = await store.addMember({ orgId, email: input.email, userSub: null, name: input.name ?? "", role: input.role, status: "invited", source: "invite", invitedBy: ctx.actorOf(c), lastSeenAt: null });
      }
      if (!m) throw new HTTPException(404, { message: "見つかりません" });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "member.invite", targetType: "member", targetId: m.id, detail: { email: m.email, role: m.role, again: Boolean(cur) } });
      const org = await store.getOrg(orgId);
      const url = loginUrl(c);
      return c.json(
        {
          member: publicMember(m),
          loginUrl: url,
          // 招待のメッセージ（メールやチャットで送る文。要件ナビからはメールを送らない）
          message: `「${org?.name ?? ""}」の要件ナビに招待しました（役割: ${ROLE_JA[m.role]}）。\n${url}\nを開き、「ログイン」から ${m.email} でログインしてください（アカウントがなければ、ログイン画面で作れます）。`,
        },
        201,
      );
    });

    app.patch("/api/orgs/:orgId/members/:id", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const input = await ctx.body(c, MemberPatchInput);
      const cur = (await store.listMembers(orgId)).find((m) => m.id === c.req.param("id"));
      if (!cur || cur.status === "removed") throw new HTTPException(404, { message: "メンバーが見つかりません" });
      if (input.role) await assertAdminRemains(orgId, cur, { role: input.role });
      const m = await store.updateMember(orgId, cur.id, { role: input.role, name: input.name });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "member.update", targetType: "member", targetId: cur.id, detail: { email: cur.email, before: { role: cur.role, name: cur.name }, after: { role: m!.role, name: m!.name } } });
      return c.json(publicMember(m!));
    });

    app.delete("/api/orgs/:orgId/members/:id", async (c) => {
      const orgId = c.req.param("orgId");
      ctx.need(c, orgId, "admin");
      const cur = (await store.listMembers(orgId)).find((m) => m.id === c.req.param("id"));
      if (!cur || cur.status === "removed") throw new HTTPException(404, { message: "メンバーが見つかりません" });
      await assertAdminRemains(orgId, cur, { removed: true });
      // 一度もログインしていない招待は消す。ログインしたことがある人は「外した」として残す（クレームで入り直せないように）
      if (cur.status === "invited" && !cur.userSub) await store.deleteMember(orgId, cur.id);
      else await store.updateMember(orgId, cur.id, { status: "removed" });
      await audit(store, { orgId, actor: ctx.actorOf(c), action: "member.remove", targetType: "member", targetId: cur.id, detail: { email: cur.email, role: cur.role, wasInvited: cur.status === "invited" } });
      return c.body(null, 204);
    });

    /* ---------- プロジェクトの整理 ---------- */
    /** 名前・目的の変更（編集者以上）、アーカイブ・元に戻す（管理者） */
    app.patch("/api/projects/:id", async (c) => {
      const input = await ctx.body(c, ProjectPatchInput);
      const p = await ctx.loadProject(c, c.req.param("id"), input.archived !== undefined ? "admin" : "editor");
      const updated = await store.updateProject(p.id, {
        name: input.name,
        purpose: input.purpose,
        archivedAt: input.archived === undefined ? undefined : input.archived ? new Date().toISOString() : null,
      });
      if (!updated) throw new HTTPException(404, { message: "プロジェクトが見つかりません" });
      if (input.name !== undefined || input.purpose !== undefined) {
        await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "project.update", targetType: "project", targetId: p.id, detail: { before: { name: p.name, purpose: p.purpose }, after: { name: updated.name, purpose: updated.purpose } } });
      }
      if (input.archived !== undefined) {
        await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: input.archived ? "project.archive" : "project.unarchive", targetType: "project", targetId: p.id, detail: { name: p.name } });
      }
      return c.json(updated);
    });

    /** 削除（管理者。プロジェクト名を入れて確認。元に戻せない） */
    app.delete("/api/projects/:id", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "admin");
      const input = await ctx.body(c, ProjectDeleteInput);
      if (input.confirmName.trim() !== p.name.trim()) throw new HTTPException(400, { message: "確認のため、プロジェクト名を正しく入れてください" });
      const [reqs] = await Promise.all([store.listRequirements(p.id)]);
      await store.deleteProject(p.id);
      await audit(store, { orgId: p.orgId, actor: ctx.actorOf(c), action: "project.delete", targetType: "project", targetId: p.id, detail: { name: p.name, requirements: reqs.length } });
      return c.body(null, 204);
    });
  }

  return { routes };
}

const ROLE_JA: Record<Role, string> = { admin: "管理者", editor: "編集者", reviewer: "レビュー担当", viewer: "閲覧者" };

/** 組織の作成時に、最初の管理者を招待しておく */
export async function seedAdmin(store: Store, orgId: string, adminEmail: string | undefined): Promise<OrgMember | null> {
  if (!adminEmail) return null;
  return store.addMember({ orgId, email: adminEmail.toLowerCase(), userSub: null, name: "", role: "admin", status: "invited", source: "bootstrap", invitedBy: "bootstrap", lastSeenAt: null });
}

/** 一覧に出すプロジェクトか（アーカイブを含めるか） */
export const visibleProject = (p: Project, includeArchived: boolean) => includeArchived || !p.archivedAt;
