-- Migration v2: Blogger OAuth Refresh Token 자동 갱신 지원
-- D1에서 실행: wrangler d1 execute wpspot-db --file=schema_migration_v2.sql
-- 참고: D1은 ALTER TABLE ... IF NOT EXISTS를 지원하지 않으므로
--       이미 컬럼이 있으면 오류가 발생할 수 있습니다.
--       오류 발생 시 해당 줄을 건너뛰어 주세요.

ALTER TABLE user_credentials ADD COLUMN gcp_blogger_refresh_token_enc TEXT;
ALTER TABLE user_credentials ADD COLUMN gcp_blogger_client_id TEXT;
ALTER TABLE user_credentials ADD COLUMN gcp_blogger_client_secret_enc TEXT;
ALTER TABLE user_credentials ADD COLUMN gcp_blogger_token_expires_at INTEGER;

-- v3: cf_api_token_enc 컬럼 추가 (Cloudflare API Token, Pages:Edit 권한)
ALTER TABLE user_credentials ADD COLUMN cf_api_token_enc TEXT;
