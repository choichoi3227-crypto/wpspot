-- schema migration v8 — nginx + PHP-FPM + MariaDB + Redis 7 스택 전환
-- 실행: wrangler d1 execute <DB_NAME> --file=schema_migration_v8.sql

-- Redis 활성화 여부 (로컬 Redis 7, 항상 활성)
ALTER TABLE site_credentials ADD COLUMN redis_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE site_credentials ADD COLUMN redis_provider TEXT DEFAULT 'Redis 7 (로컬, 무료)';

-- 스택 정보
ALTER TABLE site_credentials ADD COLUMN stack TEXT DEFAULT 'nginx+php-fpm+mariadb+redis7';

-- PHP-FPM 포트 (nginx가 upstream으로 관리)
ALTER TABLE site_credentials ADD COLUMN php_fpm_main_port TEXT DEFAULT '9000';
ALTER TABLE site_credentials ADD COLUMN php_fpm_sub_port  TEXT DEFAULT '9001';

-- nginx 포트
ALTER TABLE site_credentials ADD COLUMN nginx_wp_port  TEXT DEFAULT '8080';
ALTER TABLE site_credentials ADD COLUMN nginx_pma_port TEXT DEFAULT '8081';

-- DB 종류 (SQLite → MariaDB)
ALTER TABLE site_credentials ADD COLUMN db_type TEXT DEFAULT 'mariadb';

-- DB 백업 경로
ALTER TABLE site_credentials ADD COLUMN db_backup_path TEXT DEFAULT 'wordpress/db-backup/latest.sql.gz';
