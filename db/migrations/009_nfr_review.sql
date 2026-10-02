-- 009_nfr_review: 非機能要件の適正化（AIによる過大な水準の見直し結果）
ALTER TABLE nfr_sheets ADD COLUMN IF NOT EXISTS review jsonb;
