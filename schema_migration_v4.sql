-- schema migration v4 — tunnel_pla_url 컬럼 추가, 기존 DB 마이그레이션용
-- wrangler d1 execute <DB_NAME> --file=schema_migration_v4.sql

ALTER TABLE sites ADD COLUMN tunnel_pla_url TEXT;
ALTER TABLE sites ADD COLUMN cf_worker_name TEXT;

-- pla_tokens 없으면 생성
CREATE TABLE IF NOT EXISTS pla_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- site_domains 없으면 생성
CREATE TABLE IF NOT EXISTS site_domains (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  domain_name TEXT NOT NULL,
  cf_zone_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  name_servers TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- site_credentials pla 컬럼 추가 (이미 있으면 무시됨)
ALTER TABLE site_credentials ADD COLUMN pla_username TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE site_credentials ADD COLUMN pla_password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE site_credentials ADD COLUMN pla_password_plain_enc TEXT;
ALTER TABLE site_credentials ADD COLUMN wp_admin_username TEXT;
ALTER TABLE site_credentials ADD COLUMN wp_admin_password_plain_enc TEXT;

CREATE INDEX IF NOT EXISTS idx_pla_token    ON pla_tokens(token);
CREATE INDEX IF NOT EXISTS idx_pla_site     ON pla_tokens(site_id);
CREATE INDEX IF NOT EXISTS idx_domains_user ON site_domains(user_id);
