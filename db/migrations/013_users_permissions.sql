-- 組織設定・役割ごとの権限・要件ナビのログイン（AUTH_MODE=local）

-- 組織設定
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS contact_email text NOT NULL DEFAULT '';
-- 招待できるメールアドレスのドメイン（空ならどこでも）
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS allowed_email_domains text[] NOT NULL DEFAULT '{}';
-- 役割ごとの権限（{"editor": ["requirements.edit", ...], ...}。NULL は既定）
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS role_permissions jsonb;

-- 要件ナビのログインの利用者（組織をまたいで1人1つ。組織と役割は org_members で決める）
CREATE TABLE IF NOT EXISTS local_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  name                text NOT NULL DEFAULT '',
  -- scrypt のハッシュ。パスワードそのものは保存しない
  password_hash       text,
  failed_logins       integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  password_changed_at timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ログイン中の状態（トークンは SHA-256 のハッシュだけを保存）
CREATE TABLE IF NOT EXISTS local_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS local_sessions_user ON local_sessions (user_id);

-- パスワードを決める一回限りのリンク（招待・再設定。トークンはハッシュだけを保存）
CREATE TABLE IF NOT EXISTS auth_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  email       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('setup','reset')),
  org_id      uuid REFERENCES orgs(id) ON DELETE CASCADE,
  created_by  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tickets_email ON auth_tickets (email);
