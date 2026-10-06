import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export type Role = "admin" | "editor" | "reviewer" | "viewer";
export const ROLES: Role[] = ["admin", "editor", "reviewer", "viewer"];

export interface Principal {
  userId: string;
  /** 使う組織。組織が決まらない（所属がない）ときは空 */
  orgId: string;
  role: Role;
  /** ログインの仕組みが確認したメールアドレス（招待との照合に使う） */
  email?: string;
  emailVerified?: boolean;
  /** 表示名（ログインの仕組みが返す名前） */
  name?: string;
  /** 組織と役割がトークンのクレーム（Cognito の属性・グループ、Keycloak のロール）から来たか */
  fromClaims?: boolean;
  /** 要件ナビのログイン（AUTH_MODE=local）のセッション */
  sessionId?: string;
  /** 選んだ組織で持つ権限（permissions.ts。認証の後に組織の設定から決める） */
  permissions?: string[];
}

export type Authenticator = (req: Request) => Promise<Principal | null>;

/**
 * 開発用: ヘッダーで利用者を名乗る（x-user-id / x-org-id / x-role）。
 * 本番では AUTH_MODE=local か oidc にして必ず無効化すること。
 */
export const devAuthenticator: Authenticator = async (req) => {
  const orgId = req.headers.get("x-org-id");
  const role = (req.headers.get("x-role") ?? "editor") as Role;
  if (!orgId || !ROLES.includes(role)) return null;
  return { userId: req.headers.get("x-user-id") ?? "dev-user", orgId, role };
};

export interface OidcOptions {
  /** 例: Cognito https://cognito-idp.<region>.amazonaws.com/<poolId> / Keycloak http://localhost:8080/realms/arn */
  issuer: string;
  /**
   * 設定（discovery）を取りに行くURL。省略時は issuer から作る。
   * Docker で Keycloak を使う場合、コンテナ内からは http://keycloak:8080/... で取りに行く必要がある
   */
  discoveryUrl?: string;
  audience?: string;
  /** 組織IDが入るクレーム名（Cognitoのカスタム属性なら custom:org_id） */
  orgClaim: string;
  roleClaim: string;
  /** email_verified がなくても、メールアドレスを確認済みとして扱う（メールを送れないローカルの Keycloak 用） */
  trustUnverifiedEmail?: boolean;
  fetchImpl?: typeof fetch;
  /** 署名鍵の取得方法を差し替える（テスト用） */
  keys?: JWTVerifyGetKey;
}

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

/** OIDC プロバイダの設定（discovery）を1回だけ取得して使い回す */
export class OidcDiscoveryCache {
  private cached: Promise<OidcDiscovery> | null = null;
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  get(): Promise<OidcDiscovery> {
    if (!this.cached) {
      this.cached = (async () => {
        const res = await this.fetchImpl(this.url);
        if (!res.ok) throw new Error(`OIDCの設定を取得できません: HTTP ${res.status}`);
        return (await res.json()) as OidcDiscovery;
      })();
      this.cached.catch(() => (this.cached = null)); // 失敗したら次回やり直す
    }
    return this.cached;
  }
}

export const discoveryUrlOf = (o: Pick<OidcOptions, "issuer" | "discoveryUrl">) =>
  o.discoveryUrl ?? `${o.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;

/** OIDC のIDトークン（Bearer）を検証する。Amazon Cognito と Keycloak の両方で動く */
export function oidcAuthenticator(opts: OidcOptions, discovery = new OidcDiscoveryCache(discoveryUrlOf(opts), opts.fetchImpl)): Authenticator {
  let jwks: JWTVerifyGetKey | undefined = opts.keys;
  const getJwks = async () => {
    if (jwks) return jwks;
    jwks = createRemoteJWKSet(new URL((await discovery.get()).jwks_uri));
    return jwks;
  };
  return async (req) => {
    const h = req.headers.get("authorization");
    if (!h?.startsWith("Bearer ")) return null;
    try {
      const { payload } = await jwtVerify(h.slice(7), await getJwks(), {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      return toPrincipal(payload, opts);
    } catch {
      return null;
    }
  };
}

export interface OidcClientOptions {
  clientId: string;
  /** 機密クライアントの場合のみ。ブラウザには渡さない */
  clientSecret?: string;
  scope: string;
  /** ログアウト先（Cognito の /logout など、discovery に載らない場合に指定） */
  logoutUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface TokenSet {
  idToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

/**
 * ログイン画面用。認可コード＋PKCE のコード交換と更新をサーバー経由で行う。
 * ブラウザから直接トークン窓口を呼ばないため、CORS の設定やクライアントシークレットの露出が不要になる。
 */
export class OidcClient {
  constructor(
    private readonly discovery: OidcDiscoveryCache,
    private readonly opts: OidcClientOptions,
  ) {}

  async publicConfig() {
    const d = await this.discovery.get();
    return {
      authorizationEndpoint: d.authorization_endpoint,
      clientId: this.opts.clientId,
      scope: this.opts.scope,
      logoutUrl: this.opts.logoutUrl ?? d.end_session_endpoint ?? null,
    };
  }

  private async token(params: Record<string, string>): Promise<TokenSet> {
    const d = await this.discovery.get();
    const body = new URLSearchParams({ client_id: this.opts.clientId, ...params });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.opts.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString("base64")}`;
    }
    const res = await (this.opts.fetchImpl ?? fetch)(d.token_endpoint, { method: "POST", headers, body });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.id_token !== "string") {
      throw new Error(`ログインに失敗しました（${String(json.error_description ?? json.error ?? `HTTP ${res.status}`)}）`);
    }
    return {
      idToken: json.id_token,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresIn: typeof json.expires_in === "number" ? json.expires_in : 3600,
    };
  }

  exchange(code: string, codeVerifier: string, redirectUri: string): Promise<TokenSet> {
    return this.token({ grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const t = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
    // Cognito は更新時に refresh_token を返さないため、元のものを使い続ける
    return { ...t, refreshToken: t.refreshToken ?? refreshToken };
  }
}

/**
 * IDトークンから利用者を作る。
 * 組織と役割は、要件ナビの「組織のメンバー」で決めるのが基本（app.ts）。トークンに組織のクレームがあれば、
 * その組織のメンバーとして最初に一度だけ登録する（以前の、ログインの仕組み側で役割を決める運用との互換）
 */
export function toPrincipal(p: JWTPayload, opts: Pick<OidcOptions, "orgClaim" | "roleClaim" | "trustUnverifiedEmail">): Principal | null {
  if (!p.sub) return null;
  const orgId = p[opts.orgClaim];
  const rawRole = p[opts.roleClaim];
  // Cognito グループなどで配列になる場合は、最も強い権限を採用
  const roles = (Array.isArray(rawRole) ? rawRole : [rawRole]).filter((r): r is Role => ROLES.includes(r as Role));
  const role = ROLES.find((r) => roles.includes(r)) ?? "viewer";
  const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : undefined;
  const verified = p.email_verified === true || p.email_verified === "true" || Boolean(opts.trustUnverifiedEmail);
  const name = [p.name, p.preferred_username, p["cognito:username"]].find((x) => typeof x === "string") as string | undefined;
  const hasOrg = typeof orgId === "string" && orgId.length > 0;
  return { userId: p.sub, orgId: hasOrg ? (orgId as string) : "", role, email, emailVerified: verified, name, fromClaims: hasOrg };
}

const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, editor: 2, admin: 3 };
export function hasRole(p: Principal, min: Role): boolean {
  return RANK[p.role] >= RANK[min];
}
