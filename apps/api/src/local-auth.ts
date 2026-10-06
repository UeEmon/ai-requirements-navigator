/**
 * 要件ナビのログイン（AUTH_MODE=local）。Cognito・Keycloak を用意せずに、メールアドレスとパスワードで使う。
 *
 * - 利用者は組織をまたいで1人1つ（メールアドレスで区別）。どの組織に入れるかと役割は「組織のメンバー」で決める（org-admin.ts）
 * - パスワードは scrypt のハッシュだけを保存する。ログイン中の状態（セッション）のトークンも SHA-256 のハッシュだけを保存する
 * - 5回続けて間違えると15分ロックする。存在しないメールアドレスでも同じ時間をかけ、同じ答えを返す
 * - 最初の1人（初期設定）: 利用者が1人もいないときだけ、組織と管理者のアカウントを作れる（LOCAL_SETUP_TOKEN を設定すると、その値も必要）
 * - 招待・パスワードの再設定: 管理者が一回限りのリンクを発行し、本人に渡す（要件ナビからはメールを送らない）
 *   ほかの組織にも入っている人のパスワードは、管理者は再設定できない（本人の「パスワードの変更」だけ）
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Authenticator, Principal } from "./auth.js";
import { resolveMember } from "./org-admin.js";
import type { AuthTicket, LocalUser, OrgMember, Store } from "./store.js";

export interface LocalAuthOptions {
  /** ログインの有効時間（時間。既定 12） */
  sessionHours?: number;
  /** パスワードの最短の長さ（既定 10） */
  passwordMinLength?: number;
  /** 初期設定に必要な値（LOCAL_SETUP_TOKEN）。未設定なら、利用者が1人もいないときは誰でも初期設定できる */
  setupToken?: string;
  /** scrypt の強さ（テスト用に下げられる。既定 16384） */
  scryptN?: number;
}

export const SESSION_PREFIX = "arn_s_";
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const LINK_HOURS = { setup: 7 * 24, reset: 72 } as const;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = (prefix = "") => prefix + randomBytes(32).toString("base64url");

function scryptAsync(password: string, salt: Buffer, N: number): Promise<Buffer> {
  return new Promise((ok, ng) => scrypt(password.normalize("NFKC"), salt, 64, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (e, k) => (e ? ng(e) : ok(k))));
}

/** パスワードのハッシュ（scrypt$N$r$p$salt$hash） */
export async function hashPassword(password: string, N = 16384): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N);
  return `scrypt$${N}$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20) return false;
  const key = await scryptAsync(password, Buffer.from(parts[4]!, "base64url"), N);
  const want = Buffer.from(parts[5]!, "base64url");
  return want.length === key.length && timingSafeEqual(want, key);
}

/** パスワードの決まり。合わなければ理由を返す */
export function passwordProblem(password: string, email: string, minLength: number): string | null {
  if (password.length < minLength) return `パスワードは ${minLength} 文字以上にしてください`;
  if (password.length > 200) return "パスワードは 200 文字以下にしてください";
  if (password.trim().toLowerCase() === email.toLowerCase() || password.toLowerCase() === email.split("@")[0]!.toLowerCase()) return "メールアドレスと同じパスワードは使えません";
  if (new Set(password).size < 4) return "同じ文字の繰り返しが多すぎます。推測されにくいパスワードにしてください";
  return null;
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "メールアドレスの形式が正しくありません");
const LoginInput = z.object({ email: emailSchema, password: z.string().min(1).max(200) });
const SetupInput = z.object({
  orgName: z.string().trim().min(1).max(200),
  name: z.string().trim().max(100).default(""),
  email: emailSchema,
  password: z.string().min(1).max(200),
  setupToken: z.string().max(500).optional(),
});
const TicketInput = z.object({ token: z.string().min(10).max(200) });
const AcceptInput = z.object({ token: z.string().min(10).max(200), name: z.string().trim().max(100).optional(), password: z.string().min(1).max(200) });
const PasswordInput = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });
const ProfileInput = z.object({ name: z.string().trim().max(100) });

type Body = <T extends z.ZodTypeAny>(c: Context, schema: T) => Promise<z.infer<T>>;

export interface LocalAuth {
  authenticate: Authenticator;
  /** ログイン前に使う窓口（認証の前に登録する） */
  publicRoutes(app: Hono<any>, body: Body): void;
  /** ログインした人が使う窓口（ログアウト・パスワードの変更） */
  routes(app: Hono<any>, body: Body): void;
  /** 招待・再設定のリンクを発行する（管理者。org-admin.ts） */
  issueLink(input: { member: OrgMember; actor: string; baseUrl: string }): Promise<{ url: string; purpose: AuthTicket["purpose"]; expiresAt: string }>;
  /** 招待のときに、アカウントがあるか（パスワードを設定済みか） */
  hasPassword(email: string): Promise<boolean>;
  passwordMinLength: number;
}

export function localAuth(store: Store, opts: LocalAuthOptions = {}, nowFn: () => Date = () => new Date()): LocalAuth {
  const minLength = opts.passwordMinLength ?? 10;
  const sessionMs = (opts.sessionHours ?? 12) * 3600_000;
  const N = opts.scryptN ?? 16384;
  // 存在しないメールアドレスのときにも同じ時間をかけるためのハッシュ
  const dummy = hashPassword(randomBytes(16).toString("hex"), N);

  const authenticate: Authenticator = async (req) => {
    const h = req.headers.get("authorization");
    if (!h?.startsWith(`Bearer ${SESSION_PREFIX}`)) return null;
    const s = await store.getSessionByHash(sha256(h.slice(7)));
    if (!s || Date.parse(s.expiresAt) <= nowFn().getTime()) return null;
    const u = await store.getUser(s.userId);
    if (!u || !u.passwordHash) return null;
    return { userId: u.id, orgId: "", role: "viewer", email: u.email, emailVerified: true, name: u.name || undefined, sessionId: s.id } satisfies Principal;
  };

  const principalOf = (u: LocalUser): Principal => ({ userId: u.id, orgId: "", role: "viewer", email: u.email, emailVerified: true, name: u.name || undefined });

  /** ログインの状態を作る（トークンは返すだけで、保存はハッシュ） */
  const startSession = async (u: LocalUser) => {
    const token = newToken(SESSION_PREFIX);
    const expiresAt = new Date(nowFn().getTime() + sessionMs).toISOString();
    await store.createSession({ userId: u.id, tokenHash: sha256(token), expiresAt });
    await store.updateUser(u.id, { lastLoginAt: nowFn().toISOString(), failedLogins: 0, lockedUntil: null });
    return { token, expiresAt, expiresIn: Math.floor(sessionMs / 1000), user: { email: u.email, name: u.name } };
  };

  /** 入れる組織を確かめる（招待を結び付ける）。どこにも入れなければ 403 */
  const usableOrgs = async (u: LocalUser) => {
    const p = await resolveMember(store, principalOf(u), undefined, nowFn());
    const usable = p.memberships.filter((m) => m.status === "active" && m.userSub === u.id);
    if (!usable.length) {
      throw new HTTPException(403, { message: `まだどの組織にも招待されていないか、組織から外されています。組織の管理者に、${u.email} を招待するよう依頼してください` });
    }
    return usable;
  };

  const checkPassword = (password: string, email: string) => {
    const problem = passwordProblem(password, email, minLength);
    if (problem) throw new HTTPException(400, { message: problem });
  };

  /** リンクのトークンを確かめる */
  const ticketOf = async (token: string) => {
    const t = await store.getTicketByHash(sha256(token));
    if (!t || t.usedAt) throw new HTTPException(400, { message: "このリンクは使用済みか、無効です。管理者にリンクを発行し直してもらってください" });
    if (Date.parse(t.expiresAt) <= nowFn().getTime()) throw new HTTPException(400, { message: "このリンクは期限切れです。管理者にリンクを発行し直してもらってください" });
    return t;
  };

  function publicRoutes(app: Hono<any>, body: Body) {
    /** ログイン画面の表示に使う（初期設定が必要か・パスワードの決まり） */
    app.get("/api/auth/local/status", async (c) => {
      const setupRequired = (await store.countUsers()) === 0;
      return c.json({ setupRequired, setupTokenRequired: setupRequired && Boolean(opts.setupToken), passwordMinLength: minLength, sessionHours: sessionMs / 3600_000 });
    });

    /** 初期設定: 最初の組織と管理者のアカウントを作る（利用者が1人もいないときだけ） */
    app.post("/api/auth/local/setup", async (c) => {
      const input = await body(c, SetupInput);
      if ((await store.countUsers()) > 0) throw new HTTPException(409, { message: "初期設定は済んでいます。ログインしてください" });
      if (opts.setupToken && input.setupToken !== opts.setupToken) throw new HTTPException(403, { message: "初期設定用のトークンが違います（サーバーの LOCAL_SETUP_TOKEN）" });
      checkPassword(input.password, input.email);
      let u: LocalUser;
      try {
        u = await store.createUser({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password, N) });
      } catch {
        throw new HTTPException(409, { message: "初期設定は済んでいます。ログインしてください" });
      }
      const org = await store.createOrg(input.orgName);
      await store.addMember({ orgId: org.id, email: u.email, userSub: u.id, name: u.name, role: "admin", status: "active", source: "bootstrap", invitedBy: "setup", lastSeenAt: nowFn().toISOString() });
      await audit(store, { orgId: org.id, actor: u.id, action: "org.create", targetType: "org", targetId: org.id, detail: { name: org.name, adminEmail: u.email, via: "setup" } });
      await audit(store, { orgId: org.id, actor: u.id, action: "auth.login", detail: { role: "admin", email: u.email } });
      return c.json({ ...(await startSession(u)), orgId: org.id }, 201);
    });

    app.post("/api/auth/local/login", async (c) => {
      const input = await body(c, LoginInput);
      const u = await store.getUserByEmail(input.email);
      const wrong = () => new HTTPException(401, { message: "メールアドレスかパスワードが違います" });
      if (!u || !u.passwordHash) {
        await verifyPassword(input.password, await dummy);
        throw wrong();
      }
      if (u.lockedUntil && Date.parse(u.lockedUntil) > nowFn().getTime()) {
        throw new HTTPException(429, { message: "パスワードを続けて間違えたため、しばらくログインできません。15分ほど待ってから、もう一度お試しください" });
      }
      if (!(await verifyPassword(input.password, u.passwordHash))) {
        const fails = (u.lockedUntil ? 0 : u.failedLogins) + 1;
        await store.updateUser(u.id, fails >= MAX_FAILS ? { failedLogins: 0, lockedUntil: new Date(nowFn().getTime() + LOCK_MS).toISOString() } : { failedLogins: fails, lockedUntil: null });
        throw wrong();
      }
      const usable = await usableOrgs(u);
      const session = await startSession(u);
      for (const m of usable) await audit(store, { orgId: m.orgId, actor: u.id, action: "auth.login", detail: { role: m.role, email: u.email } });
      return c.json(session);
    });

    /** リンクの中身（画面で「〇〇 のパスワードを決めます」と出すため） */
    app.post("/api/auth/local/ticket", async (c) => {
      const t = await ticketOf((await body(c, TicketInput)).token);
      const u = await store.getUserByEmail(t.email);
      const org = t.orgId ? await store.getOrg(t.orgId) : null;
      return c.json({ email: t.email, purpose: t.purpose, orgName: org?.name ?? null, name: u?.name ?? "", expiresAt: t.expiresAt, passwordMinLength: minLength });
    });

    /** リンクからパスワードを決める（招待されたアカウントの作成・パスワードの再設定） */
    app.post("/api/auth/local/accept", async (c) => {
      const input = await body(c, AcceptInput);
      const t = await ticketOf(input.token);
      checkPassword(input.password, t.email);
      const hash = await hashPassword(input.password, N);
      if (!(await store.useTicket(t.id))) throw new HTTPException(400, { message: "このリンクは使用済みです" });
      let u = await store.getUserByEmail(t.email);
      if (!u) u = await store.createUser({ email: t.email, name: input.name ?? "", passwordHash: hash });
      else u = (await store.updateUser(u.id, { passwordHash: hash, passwordChangedAt: nowFn().toISOString(), failedLogins: 0, lockedUntil: null, ...(input.name ? { name: input.name } : {}) }))!;
      await store.revokeTickets(t.email);
      // パスワードを変えたので、ほかでのログインは終わらせる
      await store.deleteUserSessions(u.id);
      if (t.orgId) await audit(store, { orgId: t.orgId, actor: u.id, action: t.purpose === "setup" ? "auth.setup" : "auth.reset", targetType: "user", targetId: u.id, detail: { email: u.email } });
      await usableOrgs(u);
      return c.json(await startSession(u));
    });
  }

  function routes(app: Hono<any>, body: Body) {
    app.post("/api/auth/local/logout", async (c) => {
      const p = c.get("principal") as Principal;
      if (p.sessionId) await store.deleteSession(p.sessionId);
      return c.body(null, 204);
    });

    /** 自分のパスワードの変更（ほかの端末でのログインは終わる） */
    app.post("/api/auth/local/password", async (c) => {
      const p = c.get("principal") as Principal;
      const input = await body(c, PasswordInput);
      const u = await store.getUser(p.userId);
      if (!u || !p.sessionId) throw new HTTPException(400, { message: "要件ナビのログインでだけ使えます" });
      if (!(await verifyPassword(input.currentPassword, u.passwordHash))) throw new HTTPException(400, { message: "今のパスワードが違います" });
      if (input.newPassword === input.currentPassword) throw new HTTPException(400, { message: "今と違うパスワードにしてください" });
      checkPassword(input.newPassword, u.email);
      await store.updateUser(u.id, { passwordHash: await hashPassword(input.newPassword, N), passwordChangedAt: nowFn().toISOString() });
      const ended = await store.deleteUserSessions(u.id, p.sessionId);
      if (p.orgId) await audit(store, { orgId: p.orgId, actor: u.id, action: "auth.password", targetType: "user", targetId: u.id, detail: { endedSessions: ended } });
      return c.json({ ok: true, endedSessions: ended });
    });

    /** 自分の表示名の変更 */
    app.patch("/api/auth/local/profile", async (c) => {
      const p = c.get("principal") as Principal;
      const input = await body(c, ProfileInput);
      if (!p.sessionId) throw new HTTPException(400, { message: "要件ナビのログインでだけ使えます" });
      const u = await store.updateUser(p.userId, { name: input.name });
      if (!u) throw new HTTPException(404, { message: "見つかりません" });
      for (const m of await store.findMemberships({ sub: u.id })) if (m.status !== "removed") await store.updateMember(m.orgId, m.id, { name: u.name });
      return c.json({ email: u.email, name: u.name });
    });
  }

  async function issueLink({ member, actor, baseUrl }: { member: OrgMember; actor: string; baseUrl: string }) {
    if (!member.email) throw new HTTPException(400, { message: "メールアドレスのないメンバーには、リンクを発行できません" });
    const u = await store.getUserByEmail(member.email);
    const purpose: AuthTicket["purpose"] = u?.passwordHash ? "reset" : "setup";
    if (purpose === "reset") {
      // ほかの組織にも入っている人は、その組織の管理者の知らないところでパスワードを変えられないようにする
      const others = (await store.findMemberships({ sub: u!.id, email: u!.email })).filter((m) => m.status !== "removed" && m.orgId !== member.orgId);
      if (others.length) {
        throw new HTTPException(409, { message: "この人はほかの組織でも要件ナビを使っているため、管理者はパスワードを再設定できません。本人に「パスワードの変更」をしてもらうか、ログインできない場合はサーバーの管理者に相談してください" });
      }
    }
    await store.revokeTickets(member.email);
    const token = newToken();
    const expiresAt = new Date(nowFn().getTime() + LINK_HOURS[purpose] * 3600_000).toISOString();
    await store.createTicket({ tokenHash: sha256(token), email: member.email, purpose, orgId: member.orgId, createdBy: actor, expiresAt });
    return { url: `${baseUrl.replace(/\/+$/, "")}/#auth=${token}`, purpose, expiresAt };
  }

  return {
    authenticate,
    publicRoutes,
    routes,
    issueLink,
    hasPassword: async (email) => Boolean((await store.getUserByEmail(email))?.passwordHash),
    passwordMinLength: minLength,
  };
}
