-- プロジェクト単位のメンバーと、要件へのコメント

-- プロジェクトのメンバー（{"restricted": true, "members": [{"memberId": "...", "role": "editor"}]}。NULL は組織の全員が見られる）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access jsonb;

-- 要件へのコメント（相談・指摘）
CREATE TABLE IF NOT EXISTS requirement_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id    uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  -- 書いたときの要件の番号（FR-01 など）
  requirement_code  text NOT NULL,
  body              text NOT NULL,
  author_id         text NOT NULL,
  author_name       text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by       text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz
);
CREATE INDEX IF NOT EXISTS requirement_comments_project ON requirement_comments (project_id, created_at);
