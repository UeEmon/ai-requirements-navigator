-- 新規登録のリクエスト（要件ナビのログイン。ログイン画面から、まだアカウントのない人が送り、組織の管理者が承認すると招待になる）
CREATE TABLE IF NOT EXISTS signup_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       text NOT NULL,
  name        text NOT NULL DEFAULT '',
  -- 所属・使いたい理由など（本人が書いた文）
  message     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- 同じ組織・メールアドレスの未対応のリクエストは1つだけ（送り直すと上書き）
CREATE UNIQUE INDEX IF NOT EXISTS signup_requests_pending ON signup_requests (org_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS signup_requests_org ON signup_requests (org_id, created_at DESC);
