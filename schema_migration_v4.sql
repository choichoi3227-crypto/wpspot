-- schema_migration_v4.sql — pma_worker_url 컬럼 추가

-- sites 테이블에 pma_worker_url 추가
ALTER TABLE sites ADD COLUMN pma_worker_url TEXT;

-- nginx_status 콜백용 인덱스 (성능)
CREATE INDEX IF NOT EXISTS idx_site_credentials_site_id ON site_credentials(site_id);
CREATE INDEX IF NOT EXISTS idx_pla_tokens_token ON pla_tokens(token);
CREATE INDEX IF NOT EXISTS idx_pla_tokens_site_expires ON pla_tokens(site_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_site_jobs_site_id ON site_jobs(site_id);
CREATE INDEX IF NOT EXISTS idx_sites_user_id ON sites(user_id);
