-- 組織の管理: メンバーと役割（要件ナビで管理）、プロジェクトのアーカイブ
-- ログインの仕組み（Cognito / Keycloak）は本人確認だけに使い、組織と役割はここで決める。
CREATE TABLE IF NOT EXISTS org_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- 招待したメールアドレス（小文字）。ログインの仕組みが確認したメールアドレスと照合する
  email         text NOT NULL DEFAULT '',
  -- ログインの仕組みの利用者ID（sub）。初めてログインしたときに結び付ける
  user_sub      text,
  name          text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('admin','editor','reviewer','viewer')),
  -- invited: 招待中 / active: 利用中 / removed: 外した（トークンのクレームがあっても入れない）
  status        text NOT NULL CHECK (status IN ('invited','active','removed')),
  -- invite: 画面から招待 / idp: ログインの仕組みのクレームから登録 / bootstrap: 組織の作成時
  source        text NOT NULL DEFAULT 'invite',
  invited_by    text,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_email ON org_members (org_id, email) WHERE email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_sub ON org_members (org_id, user_sub) WHERE user_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_members_sub ON org_members (user_sub);
CREATE INDEX IF NOT EXISTS org_members_email ON org_members (email);

-- プロジェクトのアーカイブ（一覧に出さない。開けば見られ、元に戻せる）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
