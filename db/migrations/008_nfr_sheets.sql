-- 008_nfr_sheets: 非機能要件シート（システムの性格・項目ごとの決定・AIの提案）
CREATE TABLE IF NOT EXISTS nfr_sheets (
  project_id   uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  profile      jsonb NOT NULL DEFAULT '{}',
  decisions    jsonb NOT NULL DEFAULT '{}',
  suggestions  jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
