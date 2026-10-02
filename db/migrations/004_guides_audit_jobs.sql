-- 004: 要件の版管理、質問ガイド、監査ログ、非同期ジョブ、UMLの複数AI比較

-- 要件の編集・論理削除（番号は再利用しない）
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- どのフェーズのヒアリングで確定したか（観点の網羅チェックに使う）
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS phase_key text;

CREATE TABLE IF NOT EXISTS requirement_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  title           text NOT NULL,
  description     text NOT NULL,
  priority        text NOT NULL,
  changed_by      text NOT NULL,
  change_reason   text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, version)
);

-- フェーズごとの質問ガイドと観点の網羅状況（最新を使う）
CREATE TABLE IF NOT EXISTS phase_guides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_key   text NOT NULL,
  guide       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phase_guides_project_idx ON phase_guides(project_id, phase_key, created_at DESC);

-- 監査ログ（誰が・いつ・何をしたか。AIに送った内容の要約を含む）
CREATE TABLE IF NOT EXISTS audit_logs (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL,
  actor        text NOT NULL,
  action       text NOT NULL,
  target_type  text NOT NULL DEFAULT '',
  target_id    text NOT NULL DEFAULT '',
  detail       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_org_idx ON audit_logs(org_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_at_idx ON audit_logs(at);

-- 非同期ジョブ（複数インスタンスでも FOR UPDATE SKIP LOCKED で1回だけ実行）
CREATE TABLE IF NOT EXISTS jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid,
  kind          text NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  input         jsonb NOT NULL DEFAULT '{}',
  result        jsonb,
  error         text,
  error_status  integer,
  progress      jsonb NOT NULL DEFAULT '{}',
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);

-- UMLの複数AI比較（採用されたものが uml_models に入る）
CREATE TABLE IF NOT EXISTS uml_rounds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  candidates  jsonb NOT NULL,
  evaluation  jsonb,
  failures    jsonb NOT NULL DEFAULT '[]',
  warnings    jsonb NOT NULL DEFAULT '[]',
  status      text NOT NULL DEFAULT 'awaiting_decision',
  created_at  timestamptz NOT NULL DEFAULT now()
);
