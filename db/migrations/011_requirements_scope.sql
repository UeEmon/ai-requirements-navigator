-- 011_requirements_scope: 要件定義で決めることの追加（業務ルール・プロジェクトの決まり・用語集と受け入れ基準・レビューと承認）

-- 業務ルール（RL）と、その種類・具体例
ALTER TABLE requirements DROP CONSTRAINT IF EXISTS requirements_type_check;
ALTER TABLE requirements ADD CONSTRAINT requirements_type_check CHECK (type IN ('BR','AC','FR','RL','NFR','CN'));
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS rule jsonb;

-- プロジェクトの決まり（確定に承認が必要か など）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';

-- 用語集・受け入れ基準（プロジェクトごとに種類ごとに1つ）
CREATE TABLE IF NOT EXISTS project_sheets (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('glossary','acceptance')),
  data        jsonb NOT NULL,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind)
);

-- 要件定義のレビュー（承認の依頼と判断）
CREATE TABLE IF NOT EXISTS reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code                text NOT NULL,
  snapshot            jsonb NOT NULL,
  fingerprint         text NOT NULL,
  note                text NOT NULL DEFAULT '',
  required_approvals  int NOT NULL DEFAULT 1,
  requested_by        text NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','withdrawn')),
  decisions           jsonb NOT NULL DEFAULT '[]',
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS reviews_project_idx ON reviews(project_id, created_at DESC);
