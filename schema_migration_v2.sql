-- Migration v2: Blogger OAuth Refresh Token 자동 갱신 지원
-- D1에서 실행: wrangler d1 execute wpspot-db --file=schema_migration_v2.sql

ALTER TABLE user_credentials ADD COLUMN gcp_blogger_refresh_token_enc TEXT;
ALTER TABLE user_credentials ADD COLUMN gcp_blogger_client_id TEXT;
ALTER TABLE user_credentials ADD COLUMN gcp_blogger_client_secret_enc TEXT;
ALTER TABLE user_credentials ADD COLUMN gcp_blogger_token_expires_at INTEGER;

