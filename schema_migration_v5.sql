-- schema migration v5 — phpmyadmin_username / phpmyadmin_password NOT NULL 문제 해결
-- 실행: wrangler d1 execute <DB_NAME> --file=schema_migration_v5.sql
--
-- 배경: 구버전 site_credentials 테이블에 phpmyadmin_username, phpmyadmin_password 등
--       NOT NULL 컬럼이 남아 있어 INSERT 시 SQLITE_CONSTRAINT_NOTNULL 오류 발생.
--       SQLite는 ALTER COLUMN / DROP COLUMN DEFAULT 변경을 지원하지 않으므로
--       테이블을 재생성(rename → create → copy → drop) 방식으로 마이그레이션한다.

-- 1) 기존 테이블 백업용으로 이름 변경
ALTER TABLE site_credentials RENAME TO site_credentials_old;

-- 2) 새 테이블 생성 (schema.sql v4 기준, phpmyadmin_* 컬럼 제거)
CREATE TABLE site_credentials (
  site_id                     TEXT PRIMARY KEY,
  pla_username                TEXT NOT NULL DEFAULT 'admin',
  pla_password_hash           TEXT NOT NULL DEFAULT '',
  pla_password_plain_enc      TEXT,
  wp_admin_username           TEXT,
  wp_admin_password_plain_enc TEXT,
  db_path                     TEXT NOT NULL DEFAULT 'wp-content/database/wordpress.db',
  nginx_status                TEXT NOT NULL DEFAULT 'not_provisioned',
  created_at                  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- 3) 기존 데이터 복사 (공통 컬럼만, 없는 컬럼은 DEFAULT 사용)
INSERT INTO site_credentials
  (site_id, pla_username, pla_password_hash, pla_password_plain_enc,
   wp_admin_username, wp_admin_password_plain_enc, db_path, nginx_status, created_at)
SELECT
  site_id,
  COALESCE(pla_username, 'admin'),
  COALESCE(pla_password_hash, ''),
  pla_password_plain_enc,
  wp_admin_username,
  wp_admin_password_plain_enc,
  COALESCE(db_path, 'wp-content/database/wordpress.db'),
  COALESCE(nginx_status, 'not_provisioned'),
  COALESCE(created_at, strftime('%s','now'))
FROM site_credentials_old;

-- 4) 백업 테이블 삭제
DROP TABLE site_credentials_old;
