-- schema migration v6 — Cloudways 스타일 멀티 도메인 (Primary/Alias) 지원
-- 실행: wrangler d1 execute <DB_NAME> --file=schema_migration_v6.sql

CREATE TABLE IF NOT EXISTS site_domain_bindings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  cf_zone_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'alias',
  redirect_to_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(hostname),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_bindings_site      ON site_domain_bindings(site_id);
CREATE INDEX IF NOT EXISTS idx_bindings_hostname  ON site_domain_bindings(hostname);

-- 기존 sites.custom_domain 값을 primary 바인딩으로 마이그레이션
INSERT OR IGNORE INTO site_domain_bindings (id, site_id, cf_zone_id, hostname, role, status, created_at)
SELECT
  lower(hex(randomblob(16))),
  id,
  COALESCE(cf_zone_id, ''),
  custom_domain,
  'primary',
  CASE WHEN status = 'active' THEN 'active' ELSE 'pending' END,
  strftime('%s','now')
FROM sites
WHERE custom_domain IS NOT NULL AND custom_domain != '';
