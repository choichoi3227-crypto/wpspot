-- wpspot D1 schema
-- 워드프레스형 블로그스팟 호스팅 서비스

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 사용자가 "내 계정" 페이지에서 입력하는 API 키/토큰
-- (AES-GCM으로 암호화한 값을 저장한다고 가정. 키는 KV의 secret로 관리)
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY,
  github_token_enc TEXT,           -- GitHub Personal Access Token (repo 생성/Actions 실행 권한)
  gcp_blogger_token_enc TEXT,      -- GCP Blogger API OAuth refresh token
  cf_global_api_key_enc TEXT,      -- Cloudflare Global API Key (프록시 워커 생성용)
  cf_account_email TEXT,           -- Cloudflare 계정 이메일 (Global API Key와 함께 사용)
  cf_account_id TEXT,              -- Cloudflare Account ID
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 사용자가 생성한 "워드프레스형 블로그스팟" 사이트
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site_name TEXT NOT NULL,         -- wpspot 내부 사이트 식별 이름
  blogger_blog_id TEXT,            -- Blogspot Blog ID
  blogger_blog_url TEXT,           -- https://xxxx.blogspot.com
  github_repo TEXT,                -- owner/repo (워드프레스 원본 파일 + Actions가 있는 레포)
  cf_worker_name TEXT,             -- 프록시용 Cloudflare Worker 이름
  cf_worker_url TEXT,              -- 발급된 워커 URL
  status TEXT NOT NULL DEFAULT 'pending', -- pending | provisioning | active | error | deleted
  wp_admin_path TEXT DEFAULT '/wp-admin',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 프로비저닝/동기화 작업 로그 (GitHub Actions 트리거 추적)
CREATE TABLE IF NOT EXISTS site_jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  job_type TEXT NOT NULL,          -- provision | sync | redeploy | delete
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | success | failed
  message TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  finished_at INTEGER,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- 호스팅 상세에서 보여주는 접속 정보
-- (자체 제작 serverless phpMyAdmin / GitHub API 기반 SFTP 대체 / nginx+php ephemeral 컨테이너)
CREATE TABLE IF NOT EXISTS site_credentials (
  site_id TEXT PRIMARY KEY,

  -- phpMyAdmin-lite (자체 제작, 100% serverless: D1에 저장된 해시로 인증 후
  -- GitHub 레포의 wordpress.db(SQLite)를 sql.js로 브라우저에서 직접 읽고 쓴다)
  phpmyadmin_username TEXT NOT NULL,
  phpmyadmin_password_hash TEXT NOT NULL,   -- PBKDF2 해시 (auth.js 재사용)
  phpmyadmin_password_plain_enc TEXT,       -- 최초 1회 표시를 위한 암호화 보관 (AES-GCM)
  db_path TEXT NOT NULL DEFAULT 'wordpress/wp-content/database/wordpress.db',

  -- SFTP 대체: GitHub Contents API 기반 파일 관리자
  -- 실제 SFTP 포트는 없으며, github_repo 전체가 파일시스템 루트로 매핑된다.
  sftp_username TEXT NOT NULL,              -- GitHub 계정 로그인명 (표시용)
  sftp_path_root TEXT NOT NULL DEFAULT '/', -- 레포 루트 기준 경로

  -- nginx+php: provision.yml(ephemeral GitHub Actions 컨테이너)이 매 실행마다
  -- nginx.conf / php opcache 설정을 재생성하므로 별도 자격증명 없음.
  nginx_status TEXT NOT NULL DEFAULT 'not_provisioned', -- not_provisioned | building | ready | error

  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_site ON site_jobs(site_id);
