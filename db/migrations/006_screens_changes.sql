-- 006_screens_changes: 画面設計（ワイヤーフレーム）と、要件定義の確定・変更要求・影響分析

-- 画面一覧（作り直すたびに revision が上がる）
CREATE TABLE IF NOT EXISTS screen_models (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model        jsonb NOT NULL,
  provider_id  text NOT NULL,
  basis        jsonb NOT NULL DEFAULT '[]',
  revision     integer NOT NULL DEFAULT 1,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS screen_models_project_idx ON screen_models(project_id, created_at DESC);

-- 画面への意見（見た目の細部は設計工程への申し送り）
CREATE TABLE IF NOT EXISTS screen_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  screen_key        text,
  text              text NOT NULL,
  level             text NOT NULL CHECK (level IN ('detail','requirement','mixed')),
  detail_hits       jsonb NOT NULL DEFAULT '[]',
  requirement_hits  jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL CHECK (status IN ('open','applied','noted')),
  revision          integer NOT NULL DEFAULT 0,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS screen_feedback_project_idx ON screen_feedback(project_id, created_at);

-- 要件定義の確定版（その時点の要件の写し）
CREATE TABLE IF NOT EXISTS baselines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  snapshot    jsonb NOT NULL,
  reason      text NOT NULL DEFAULT '',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

-- 確定後の変更要求と影響分析
CREATE TABLE IF NOT EXISTS change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('modify','add','delete')),
  requirement_id    uuid,
  requirement_code  text,
  proposal          jsonb,
  reason            text NOT NULL DEFAULT '',
  status            text NOT NULL CHECK (status IN ('open','analyzed','approved','deferred','rejected')),
  impact            jsonb,
  decision          jsonb,
  source            text NOT NULL DEFAULT 'manual',
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  UNIQUE (project_id, code)
);
CREATE INDEX IF NOT EXISTS change_requests_project_idx ON change_requests(project_id, created_at DESC);
