-- 利用量に、入力のうちプロンプトのキャッシュから読んだトークン数を足す（input_tokens はキャッシュの分を含む合計）
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0;
