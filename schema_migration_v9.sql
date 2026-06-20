-- schema migration v9 — phpMyAdmin + MariaDB/MySQL metadata
-- 실행: wrangler d1 execute <DB_NAME> --file=schema_migration_v9.sql

ALTER TABLE site_credentials ADD COLUMN pma_username TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE site_credentials ADD COLUMN pma_password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE site_credentials ADD COLUMN pma_password_plain_enc TEXT;
ALTER TABLE site_credentials ADD COLUMN db_engine TEXT NOT NULL DEFAULT 'MariaDB/MySQL';
ALTER TABLE site_credentials ADD COLUMN db_host TEXT NOT NULL DEFAULT '127.0.0.1';
ALTER TABLE site_credentials ADD COLUMN db_port TEXT NOT NULL DEFAULT '3306';
ALTER TABLE site_credentials ADD COLUMN db_name TEXT NOT NULL DEFAULT 'wordpress';
ALTER TABLE site_credentials ADD COLUMN db_username TEXT NOT NULL DEFAULT 'wpuser';

ALTER TABLE site_credentials ADD COLUMN php_main_ports TEXT DEFAULT '8080';
ALTER TABLE site_credentials ADD COLUMN php_sub_ports TEXT DEFAULT '8081';
ALTER TABLE site_credentials ADD COLUMN php_active_ports TEXT DEFAULT '8080,8081';

UPDATE site_credentials
SET pma_username = COALESCE(NULLIF(pma_username, ''), pla_username, 'admin'),
    pma_password_hash = COALESCE(NULLIF(pma_password_hash, ''), pla_password_hash, ''),
    pma_password_plain_enc = COALESCE(pma_password_plain_enc, pla_password_plain_enc),
    db_path = CASE
      WHEN db_path LIKE '%wordpress.db%' THEN 'wordpress@127.0.0.1:3306'
      ELSE COALESCE(db_path, 'wordpress@127.0.0.1:3306')
    END,
    db_engine = 'MariaDB/MySQL',
    db_host = '127.0.0.1',
    db_port = '3306',
    db_name = 'wordpress',
    db_username = 'wpuser';


CREATE TABLE IF NOT EXISTS pma_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);
CREATE INDEX IF NOT EXISTS idx_pma_token ON pma_tokens(token);
CREATE INDEX IF NOT EXISTS idx_pma_site ON pma_tokens(site_id);
INSERT OR IGNORE INTO pma_tokens (id, site_id, token, expires_at, created_at)
SELECT id, site_id, token, expires_at, created_at FROM pla_tokens;
