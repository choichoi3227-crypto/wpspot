-- schema migration v8 — 서버리스 Redis (Upstash) 지원 추가
-- 실행: wrangler d1 execute <DB_NAME> --file=schema_migration_v8.sql
--
-- 배경: 각 WordPress 사이트에 Upstash Redis Object Cache 연동 여부를 저장한다.
--       provision.yml에서 Upstash URL/Token이 제공된 경우 자동으로 활성화된다.

ALTER TABLE site_credentials ADD COLUMN redis_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_credentials ADD COLUMN redis_provider TEXT DEFAULT NULL;

-- PHP 서버 포트 목록도 추적 (다중 서버 지원)
ALTER TABLE site_credentials ADD COLUMN php_main_ports TEXT DEFAULT '8888,8889';
ALTER TABLE site_credentials ADD COLUMN php_sub_ports  TEXT DEFAULT '8890,8891,8892,8893,8894,8895,8896,8897';
ALTER TABLE site_credentials ADD COLUMN php_active_ports TEXT DEFAULT '8888,8889';
