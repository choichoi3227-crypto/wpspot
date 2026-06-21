-- wpspot PostgreSQL 메인 DB 스키마 (항목 8)
--
-- 역할 분담:
--   PostgreSQL (이 파일, 메인)  → 플랫폼 운영 데이터: 계정/사이트 메타/결제/관리자
--   Cloudflare D1 (서브/백업)    → 위와 동일한 테이블을 Worker가 매 쓰기마다 비동기 복제
--   각 사이트의 MariaDB/D1       → 그 사이트의 실제 워드프레스 콘텐츠 (wp_posts 등, 변경 없음)
--
-- D1의 schema.sql / schema_migration_v10.sql 과 1:1 대응되도록 컬럼을 맞췄습니다.
-- (TEXT PRIMARY KEY는 D1과 동일하게 UUID 문자열을 그대로 사용 — gen_random_uuid() 강제 안 함)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  plan TEXT NOT NULL DEFAULT 'light',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  github_token_enc TEXT,
  github_token_invalid BOOLEAN NOT NULL DEFAULT FALSE,
  cf_global_api_key_enc TEXT,
  cf_api_token_enc TEXT,
  cf_account_email TEXT,
  cf_account_id TEXT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  site_name TEXT NOT NULL,
  site_slug TEXT NOT NULL,
  github_repo TEXT,
  cf_worker_name TEXT,
  cf_worker_url TEXT,
  tunnel_pla_url TEXT,
  cf_zone_id TEXT,
  custom_domain TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  plan TEXT NOT NULL DEFAULT 'light',
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS site_jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  message TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT,
  finished_at BIGINT
);

CREATE TABLE IF NOT EXISTS site_credentials (
  site_id TEXT PRIMARY KEY REFERENCES sites(id),
  pla_username TEXT NOT NULL DEFAULT 'admin',
  pla_password_hash TEXT NOT NULL DEFAULT '',
  pla_password_plain_enc TEXT,
  pma_username TEXT NOT NULL DEFAULT 'admin',
  pma_password_hash TEXT NOT NULL DEFAULT '',
  pma_password_plain_enc TEXT,
  wp_admin_username TEXT,
  wp_admin_password_plain_enc TEXT,
  db_path TEXT NOT NULL DEFAULT 'wordpress@127.0.0.1:3306',
  db_engine TEXT NOT NULL DEFAULT 'MariaDB/MySQL',
  db_host TEXT NOT NULL DEFAULT '127.0.0.1',
  db_port TEXT NOT NULL DEFAULT '3306',
  db_name TEXT NOT NULL DEFAULT 'wordpress',
  db_username TEXT NOT NULL DEFAULT 'wpuser',
  nginx_status TEXT NOT NULL DEFAULT 'not_provisioned',
  redis_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  redis_provider TEXT DEFAULT 'Redis 7 (로컬, 무료)',
  stack TEXT DEFAULT 'nginx+php-fpm+mariadb+redis7',
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS pma_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  token TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS pla_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  token TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS site_domains (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  domain_name TEXT NOT NULL,
  cf_zone_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  name_servers TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS site_domain_bindings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  cf_zone_id TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'alias',
  redirect_to_primary BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'card',
  brand TEXT,
  last4 TEXT,
  paypal_email TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'paid',
  year TEXT NOT NULL,
  month TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_site_jobs_site ON site_jobs(site_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_user_year ON billing_invoices(user_id, year);

-- PostgREST 권한: web_anon(비인증)은 아무 권한 없음, wpspot 역할(Worker가 사용)에 전체 권한 부여.
-- scripts/pg-bootstrap.sh 에서 web_anon / pgrst_authenticator 역할을 생성합니다.
GRANT USAGE ON SCHEMA public TO wpspot, web_anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO wpspot;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO wpspot;
