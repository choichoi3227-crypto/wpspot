-- schema migration v3 — 블로그스팟 컬럼 제거, 신규 컬럼 추가
-- 기존 D1 DB에 적용 (wrangler d1 execute)

-- user_credentials: GCP/Blogger 컬럼 제거는 SQLite에서 DROP COLUMN 미지원이므로 무시 (무해)
-- 신규 컬럼 추가 (이미 존재하면 에러 무시)
ALTER TABLE sites ADD COLUMN cf_zone_id TEXT;
ALTER TABLE sites ADD COLUMN custom_domain TEXT;

-- phpmyadmin_tokens → pla_tokens 새 테이블 (기존 테이블 유지, 새 테이블 생성)
CREATE TABLE IF NOT EXISTS pla_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- site_credentials: pla 컬럼 추가
ALTER TABLE site_credentials ADD COLUMN pla_username TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE site_credentials ADD COLUMN pla_password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE site_credentials ADD COLUMN pla_password_plain_enc TEXT;
ALTER TABLE site_credentials ADD COLUMN wp_admin_username TEXT;
ALTER TABLE site_credentials ADD COLUMN wp_admin_password_plain_enc TEXT;

-- site_domains 테이블 신규
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

CREATE INDEX IF NOT EXISTS idx_domains_user ON site_domains(user_id);
CREATE INDEX IF NOT EXISTS idx_pla_token    ON pla_tokens(token);
CREATE INDEX IF NOT EXISTS idx_pla_site     ON pla_tokens(site_id);
