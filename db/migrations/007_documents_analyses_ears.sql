-- 007_documents_analyses_ears: 資料の取り込みと分析、要件の EARS 記法

-- 機能要件・非機能要件の EARS の構造（title はここから組み立てた文）
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS ears jsonb;

-- 取り込んだ資料（本文のテキストのみ。元のファイルは保存しない）
CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'other',
  format      text NOT NULL,
  text        text NOT NULL,
  chars       integer NOT NULL,
  truncated   boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_project_idx ON documents(project_id, created_at);

-- 資料の分析（現状の課題・業務の見直し・初回の要件案）
CREATE TABLE IF NOT EXISTS analyses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_ids  jsonb NOT NULL DEFAULT '[]',
  focus         text NOT NULL DEFAULT '',
  candidates    jsonb NOT NULL,
  evaluation    jsonb,
  failures      jsonb NOT NULL DEFAULT '[]',
  warnings      jsonb NOT NULL DEFAULT '[]',
  notes         jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'awaiting_decision' CHECK (status IN ('awaiting_decision','adopted')),
  adoption      jsonb,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analyses_project_idx ON analyses(project_id, created_at DESC);
