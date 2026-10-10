/**
 * 役割ごとにできること（権限）。
 *
 * - 操作ごとに「権限」を決め、役割（管理者・編集者・レビュー担当・閲覧者）に権限を割り当てる
 * - 既定の割り当ては下の min（その役割以上なら持つ）。組織の管理者が「組織」タブで役割ごとに変えられる
 * - 管理者はすべての権限を持つ（変えられない）。管理者だけの権限（組織設定・ユーザーの管理）は、ほかの役割に渡せない
 *   → 組織の設定とユーザーを管理できるのは、常に管理者（組織に1人以上）
 * - プロジェクトの閲覧は、全員が持つ（外せない）
 */
import type { Role } from "./auth.js";

export const PERMISSION_KEYS = [
  "project.view",
  "export",
  "project.create",
  "requirements.edit",
  "review.approve",
  "comment.write",
  "tasks.publish",
  "project.settings",
  "project.manage",
  "ai.manage",
  "integration.manage",
  "agent.manage",
  "usage.view",
  "audit.view",
  "org.settings",
  "member.manage",
] as const;
export type Permission = (typeof PERMISSION_KEYS)[number];

export interface PermissionInfo {
  key: Permission;
  label: string;
  desc: string;
  /** 既定でこの役割以上が持つ */
  min: Role;
  /** all: 全員が持つ（外せない） / admin: 管理者だけ（ほかの役割に渡せない） */
  locked?: "all" | "admin";
  group: "project" | "org";
}

export const PERMISSIONS: PermissionInfo[] = [
  { key: "project.view", label: "プロジェクトの閲覧", desc: "要件・設計・レビューの状況などを見る", min: "viewer", locked: "all", group: "project" },
  { key: "export", label: "出力・ダウンロード", desc: "仕様書・テストシナリオ・開発用パッケージ・課題のファイルを取り出す", min: "viewer", group: "project" },
  { key: "project.create", label: "プロジェクトの作成", desc: "新しいプロジェクトを作る・サンプルを読み込む・複製する・書き出したファイルから取り込む", min: "editor", group: "project" },
  { key: "requirements.edit", label: "要件・設計の作成と編集", desc: "ヒアリング・AIでの案の作成と採用・要件の手直し・UML・画面・非機能要求・変更管理・レビューの依頼", min: "editor", group: "project" },
  { key: "review.approve", label: "レビュー・承認", desc: "レビューの承認・差し戻し、受け入れ条件の確認", min: "reviewer", group: "project" },
  { key: "comment.write", label: "要件へのコメント", desc: "要件ごとにコメント（相談・指摘）を書く・解決にする", min: "reviewer", group: "project" },
  { key: "tasks.publish", label: "課題管理ツールへの登録", desc: "実装タスクを GitHub・Jira・Backlog に登録する", min: "editor", group: "project" },
  { key: "project.settings", label: "プロジェクトの名前・AIの構成の変更", desc: "名前・目的・使う AI（モード・生成AI・評価AI）を変える", min: "editor", group: "project" },
  { key: "project.manage", label: "プロジェクトの管理", desc: "アーカイブ・削除・承認の決まり（確定に承認を必須にするなど）・プロジェクトのメンバー", min: "admin", group: "project" },
  { key: "ai.manage", label: "AI設定", desc: "AI の登録・API キーの登録と変更・自動発行", min: "admin", group: "org" },
  { key: "integration.manage", label: "課題管理ツールとの連携", desc: "連携先の登録・変更・リポジトリの自動作成", min: "admin", group: "org" },
  { key: "agent.manage", label: "開発ツールとの連携", desc: "AIコーディングツール・CI 用のトークンと Webhook の管理", min: "admin", group: "org" },
  { key: "usage.view", label: "利用量の確認", desc: "AI の今月の利用量を見る", min: "admin", group: "org" },
  { key: "audit.view", label: "操作の記録（監査ログ）の閲覧", desc: "誰がいつ何をしたかを見る", min: "admin", group: "org" },
  { key: "org.settings", label: "組織設定の変更", desc: "組織名・説明・月間上限・招待できるメールのドメイン・役割ごとの権限", min: "admin", locked: "admin", group: "org" },
  { key: "member.manage", label: "ユーザーの管理", desc: "ユーザーの招待・役割の変更・外す・パスワードの再設定", min: "admin", locked: "admin", group: "org" },
];

const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, editor: 2, admin: 3 };
/** 割り当てを変えられる役割（管理者は常にすべて） */
export const CONFIGURABLE_ROLES = ["editor", "reviewer", "viewer"] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];
/** 組織ごとの割り当て（役割 → 権限の一覧）。null・省略は既定 */
export type RolePermissions = Partial<Record<ConfigurableRole, Permission[]>>;

const info = new Map(PERMISSIONS.map((p) => [p.key, p]));
export const permissionLabel = (k: Permission) => info.get(k)?.label ?? k;
export const permissionGroup = (k: Permission) => info.get(k)?.group ?? "org";
export const isPermission = (k: string): k is Permission => info.has(k as Permission);

export function defaultPermissions(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => RANK[role] >= RANK[p.min]).map((p) => p.key);
}

/** 役割が持つ権限（組織の割り当てを反映。固定のものは割り当てに関係なく決まる） */
export function permissionsOf(matrix: RolePermissions | null | undefined, role: Role): Permission[] {
  if (role === "admin") return PERMISSION_KEYS.slice();
  const set = new Set<Permission>(matrix?.[role] ?? defaultPermissions(role));
  for (const p of PERMISSIONS) {
    if (p.locked === "all") set.add(p.key);
    if (p.locked === "admin") set.delete(p.key);
  }
  return PERMISSION_KEYS.filter((k) => set.has(k));
}

/** 保存する前に整える（知らない権限・固定のものを除く。既定と同じ役割は保存しない） */
export function normalizeRolePermissions(input: Partial<Record<string, string[]>>): RolePermissions | null {
  const out: RolePermissions = {};
  for (const r of CONFIGURABLE_ROLES) {
    const list = input[r];
    if (!list) continue;
    const keys = PERMISSION_KEYS.filter((k) => list.includes(k) && !info.get(k)!.locked);
    const def = defaultPermissions(r).filter((k) => !info.get(k)!.locked);
    if (keys.length === def.length && keys.every((k) => def.includes(k))) continue;
    out[r] = keys;
  }
  return Object.keys(out).length ? out : null;
}

/** 画面に出す表（役割ごとに持つ権限と、既定かどうか） */
export function permissionMatrix(matrix: RolePermissions | null | undefined) {
  const roles: Role[] = ["admin", "editor", "reviewer", "viewer"];
  return {
    permissions: PERMISSIONS,
    roles: roles.map((r) => ({ role: r, permissions: permissionsOf(matrix, r), defaults: r === "admin" ? PERMISSION_KEYS.slice() : permissionsOf(null, r), customized: r !== "admin" && Boolean(matrix?.[r as ConfigurableRole]) })),
  };
}
