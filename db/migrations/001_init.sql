-- 001_init: 要件定義支援システムの初期スキーマ（PostgreSQL 13以上）

CREATE TABLE IF NOT EXISTS orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 組織ごとに管理者が登録するAIの接続情報（APIキーは暗号化済み）
CREATE TABLE IF NOT EXISTS provider_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  vendor         text NOT NULL CHECK (vendor IN ('anthropic','openai','gemini','ollama','mock')),
  model          text NOT NULL,
  label          text NOT NULL,
  endpoint       text,
  encrypted_key  text,
  key_last4      text,
  is_local       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_credentials_org_idx ON provider_credentials(org_id);

CREATE TABLE IF NOT EXISTS projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          text NOT NULL,
  purpose       text NOT NULL DEFAULT '',
  confidential  boolean NOT NULL DEFAULT false,
  phase_key     text NOT NULL DEFAULT 'purpose',
  ai_config     jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(org_id);

-- 1回の質問に対する複数AIの案・評価（決定前は提供元を画面に出さない）
CREATE TABLE IF NOT EXISTS rounds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_key   text NOT NULL,
  answer      text NOT NULL,
  candidates  jsonb NOT NULL,
  evaluation  jsonb,
  failures    jsonb NOT NULL DEFAULT '[]',
  warnings    jsonb NOT NULL DEFAULT '[]',
  status      text NOT NULL DEFAULT 'awaiting_decision',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rounds_project_idx ON rounds(project_id);

CREATE TABLE IF NOT EXISTS requirements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('BR','AC','FR','NFR','CN')),
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  priority     text NOT NULL DEFAULT 'should',
  round_id     uuid REFERENCES rounds(id) ON DELETE SET NULL,
  source       text NOT NULL DEFAULT '',
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id    uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  pick        text NOT NULL,
  reason      text NOT NULL DEFAULT '',
  mapping     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 利用量（トークン）の記録。組織単位で集計する
CREATE TABLE IF NOT EXISTS usage_records (
  id             bigserial PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_id    text NOT NULL,
  project_id     uuid,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_records_org_idx ON usage_records(org_id, at);
