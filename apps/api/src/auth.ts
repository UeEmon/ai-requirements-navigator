import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type Role = "admin" | "editor" | "reviewer" | "viewer";
const ROLES: Role[] = ["admin", "editor", "reviewer", "viewer"];

export interface Principal {
  userId: string;
  orgId: string;
  role: Role;
}

export type Authenticator = (req: Request) => Promise<Principal | null>;

/**
 * 開発用: ヘッダーで利用者を名乗る（x-user-id / x-org-id / x-role）。
 * 本番では AUTH_MODE=oidc にして必ず無効化すること。
 */
export const devAuthenticator: Authenticator = async (req) => {
  const orgId = req.headers.get("x-org-id");
  const role = (req.headers.get("x-role") ?? "editor") as Role;
  if (!orgId || !ROLES.includes(role)) return null;
  return { userId: req.headers.get("x-user-id") ?? "dev-user", orgId, role };
};

export interface OidcOptions {
  /** 例: Cognito https://cognito-idp.<region>.amazonaws.com/<poolId> / Keycloak http://keycloak:8080/realms/arn */
  issuer: string;
  audience?: string;
  /** 組織IDが入るクレーム名（Cognitoのカスタム属性なら custom:org_id） */
  orgClaim: string;
  roleClaim: string;
  fetchImpl?: typeof fetch;
}

/** OIDC のアクセストークン（Bearer）を検証する。Amazon Cognito と Keycloak の両方で動く */
export function oidcAuthenticator(opts: OidcOptions): Authenticator {
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  const f = opts.fetchImpl ?? fetch;
  const getJwks = async () => {
    if (jwks) return jwks;
    const res = await f(`${opts.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDCの設定を取得できません: HTTP ${res.status}`);
    const conf = (await res.json()) as { jwks_uri: string };
    jwks = createRemoteJWKSet(new URL(conf.jwks_uri));
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

function toPrincipal(p: JWTPayload, opts: OidcOptions): Principal | null {
  const orgId = p[opts.orgClaim];
  const rawRole = p[opts.roleClaim];
  // Cognito グループなどで配列になる場合は、最も強い権限を採用
  const roles = (Array.isArray(rawRole) ? rawRole : [rawRole]).filter((r): r is Role => ROLES.includes(r as Role));
  const role = ROLES.find((r) => roles.includes(r)) ?? "viewer";
  if (typeof orgId !== "string" || !p.sub) return null;
  return { userId: p.sub, orgId, role };
}

const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, editor: 2, admin: 3 };
export function hasRole(p: Principal, min: Role): boolean {
  return RANK[p.role] >= RANK[min];
}
