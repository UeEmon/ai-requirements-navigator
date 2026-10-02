-- 005_implementation: 実装工程への連携（タスク分解・課題管理ツールへの登録・トレーサビリティ）

-- 課題管理ツールとの接続（トークンは暗号化済み。AAD/暗号化コンテキストは組織ID）
CREATE TABLE IF NOT EXISTS integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('github','jira','backlog')),
  label             text NOT NULL,
  config            jsonb NOT NULL DEFAULT '{}',
  encrypted_secret  text NOT NULL,
  secret_last4      text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz
);
CREATE INDEX IF NOT EXISTS integrations_org_idx ON integrations(org_id);

-- 要件から分解したエピック・ストーリー・タスク
CREATE TABLE IF NOT EXISTS task_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan         jsonb NOT NULL,
  provider_id  text NOT NULL,
  basis        jsonb NOT NULL DEFAULT '[]',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_plans_project_idx ON task_plans(project_id, created_at DESC);

-- 外部ツールへの登録結果（ストーリー → 課題URL）。接続を削除しても履歴は残す
CREATE TABLE IF NOT EXISTS task_exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id         uuid NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
  integration_id  uuid NOT NULL,
  kind            text NOT NULL,
  target          text NOT NULL DEFAULT '',
  items           jsonb NOT NULL DEFAULT '[]',
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_exports_plan_idx ON task_exports(plan_id, created_at DESC);
