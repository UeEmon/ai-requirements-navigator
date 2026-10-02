-- 002_uml_models: AIが生成したUML設計モデル（版として履歴を残す）

CREATE TABLE IF NOT EXISTS uml_models (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model        jsonb NOT NULL,
  provider_id  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uml_models_project_idx ON uml_models(project_id, created_at DESC);
