-- 010_connect: AIコーディングツール・テストツールとの連携（APIトークン・実装状況・テスト結果・質問・Webhook）

-- 外部連携用のトークン（トークンそのものは保存せず SHA-256 のみ）
CREATE TABLE IF NOT EXISTS api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  last4         text NOT NULL,
  scopes        jsonb NOT NULL DEFAULT '["read"]',
  project_ids   jsonb,
  expires_at    timestamptz,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_org_idx ON api_tokens(org_id);

-- 要件ごとの実装状況の報告（履歴として残し、最新を使う）
CREATE TABLE IF NOT EXISTS impl_reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_code     text NOT NULL,
  status               text NOT NULL CHECK (status IN ('not_started','in_progress','implemented','blocked')),
  requirement_version  int NOT NULL,
  refs                 jsonb NOT NULL DEFAULT '[]',
  note                 text NOT NULL DEFAULT '',
  reported_by          text NOT NULL,
  at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS impl_reports_project_idx ON impl_reports(project_id, at);

-- テストの実行結果（テストID・要件IDに結びつけたもの）
CREATE TABLE IF NOT EXISTS test_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool          text NOT NULL DEFAULT '',
  revision      text NOT NULL DEFAULT '',
  url           text NOT NULL DEFAULT '',
  format        text NOT NULL,
  tests         jsonb NOT NULL DEFAULT '[]',
  requirements  jsonb NOT NULL DEFAULT '[]',
  unmatched     jsonb NOT NULL DEFAULT '[]',
  summary       jsonb NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_runs_project_idx ON test_runs(project_id, created_at DESC);

-- AIコーディングツールなどからの質問
CREATE TABLE IF NOT EXISTS agent_questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code              text NOT NULL,
  requirement_code  text,
  text              text NOT NULL,
  context           text NOT NULL DEFAULT '',
  asked_by          text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  answer            text NOT NULL DEFAULT '',
  answered_by       text,
  answered_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

-- 外部システムへの通知（署名の秘密は暗号化済み。AAD/暗号化コンテキストは組織ID）
CREATE TABLE IF NOT EXISTS webhooks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url               text NOT NULL,
  events            jsonb NOT NULL DEFAULT '[]',
  encrypted_secret  text NOT NULL,
  last_status       text,
  last_at           timestamptz,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_org_idx ON webhooks(org_id);
