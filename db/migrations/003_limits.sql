-- 003_limits: 月間トークン上限（組織全体・登録AIごと）。NULL は上限なし

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS monthly_token_limit integer CHECK (monthly_token_limit IS NULL OR monthly_token_limit > 0);
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS monthly_token_limit integer CHECK (monthly_token_limit IS NULL OR monthly_token_limit > 0);
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS updated_at timestamptz;
