-- wpspot D1 schema
-- 워드프레스형 블로그스팟 호스팅 서비스

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 사용자 API 키/토큰 (AES-256-GCM 암호화 저장)
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY,
  github_token_enc TEXT,           -- GitHub Personal Access Token (repo+workflow 권한)
  gcp_blogger_token_enc TEXT,      -- GCP Blogger API OAuth refresh token
  cf_global_api_key_enc TEXT,      -- Cloudflare Global API Key
  cf_account_email TEXT,           -- Cloudflare 계정 이메일
  cf_account_id TEXT,              -- Cloudflare Account ID
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 사용자가 생성한 사이트
-- site_name: 표시용(한글/영어 가능), site_slug: URL용 slug(자동 생성)
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site_name TEXT NOT NULL,         -- 표시용 사이트 이름 (한글/영어 모두 허용)
  site_slug TEXT NOT NULL,         -- URL 안전 slug (영문/숫자/하이픈, site_name에서 자동 변환)
  blogger_blog_id TEXT,            -- Blogspot Blog ID
  blogger_blog_url TEXT,           -- https://xxxx.blogspot.com
  github_repo TEXT,                -- owner/repo
  cf_worker_name TEXT,
  cf_worker_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  wp_admin_path TEXT DEFAULT '/wp-admin',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 프로비저닝/동기화 작업 로그
CREATE TABLE IF NOT EXISTS site_jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  message TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  finished_at INTEGER,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- 호스팅 접속 정보
CREATE TABLE IF NOT EXISTS site_credentials (
  site_id TEXT PRIMARY KEY,
  phpmyadmin_username TEXT NOT NULL,
  phpmyadmin_password_hash TEXT NOT NULL,
  phpmyadmin_password_plain_enc TEXT,
  db_path TEXT NOT NULL DEFAULT 'wordpress/wp-content/database/wordpress.db',
  sftp_username TEXT NOT NULL,
  sftp_path_root TEXT NOT NULL DEFAULT '/',
  nginx_status TEXT NOT NULL DEFAULT 'not_provisioned',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- phpMyAdmin 일일 접속 난수 토큰
-- 매일 자정 초기화. 경로: phpmyadmin.cloud-press.co.kr/{token}/
CREATE TABLE IF NOT EXISTS phpmyadmin_tokens (
  id TEXT PRIMARY KEY,             -- UUID
  site_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,      -- 랜덤 난수 (32자 hex)
  expires_at INTEGER NOT NULL,     -- unix timestamp (다음날 자정 KST)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- ============================================================
-- WordPress 전체 WP 스키마 (자체 phpMyAdmin DB에 저장)
-- 각 사이트별로 사이트 ID를 접두어로 구분
-- ============================================================

-- wp_options: 사이트 기본 설정 (siteurl, blogname, admin_email 등)
CREATE TABLE IF NOT EXISTS wp_options (
  option_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  option_name TEXT NOT NULL,
  option_value TEXT NOT NULL DEFAULT '',
  autoload TEXT NOT NULL DEFAULT 'yes',
  UNIQUE(site_id, option_name),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_users: 워드프레스 사용자
CREATE TABLE IF NOT EXISTS wp_users (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_pass TEXT NOT NULL,
  user_nicename TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  user_url TEXT NOT NULL DEFAULT '',
  user_registered TEXT NOT NULL DEFAULT '',
  user_activation_key TEXT NOT NULL DEFAULT '',
  user_status INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_usermeta: 워드프레스 사용자 메타
CREATE TABLE IF NOT EXISTS wp_usermeta (
  umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_posts: 글/페이지/커스텀 포스트 (메타데이터만; 실제 콘텐츠는 Blogspot+GitHub)
CREATE TABLE IF NOT EXISTS wp_posts (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  post_author INTEGER NOT NULL DEFAULT 0,
  post_date TEXT NOT NULL DEFAULT '',
  post_date_gmt TEXT NOT NULL DEFAULT '',
  post_content TEXT NOT NULL DEFAULT '',  -- Blogspot에 저장된 콘텐츠의 참조 URL
  post_title TEXT NOT NULL DEFAULT '',
  post_excerpt TEXT NOT NULL DEFAULT '',
  post_status TEXT NOT NULL DEFAULT 'publish',
  comment_status TEXT NOT NULL DEFAULT 'open',
  ping_status TEXT NOT NULL DEFAULT 'open',
  post_password TEXT NOT NULL DEFAULT '',
  post_name TEXT NOT NULL DEFAULT '',
  to_ping TEXT NOT NULL DEFAULT '',
  pinged TEXT NOT NULL DEFAULT '',
  post_modified TEXT NOT NULL DEFAULT '',
  post_modified_gmt TEXT NOT NULL DEFAULT '',
  post_content_filtered TEXT NOT NULL DEFAULT '',
  post_parent INTEGER NOT NULL DEFAULT 0,
  guid TEXT NOT NULL DEFAULT '',
  menu_order INTEGER NOT NULL DEFAULT 0,
  post_type TEXT NOT NULL DEFAULT 'post',
  post_mime_type TEXT NOT NULL DEFAULT '',
  comment_count INTEGER NOT NULL DEFAULT 0,
  blogger_post_id TEXT,            -- Blogspot 게시물 ID (콘텐츠 저장 위치)
  github_path TEXT,                -- GitHub 레포 내 파일 경로 (미디어 등)
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_postmeta: 포스트 메타데이터
CREATE TABLE IF NOT EXISTS wp_postmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_terms: 카테고리/태그
CREATE TABLE IF NOT EXISTS wp_terms (
  term_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  term_group INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_term_taxonomy
CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
  term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  term_id INTEGER NOT NULL DEFAULT 0,
  taxonomy TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  parent INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_term_relationships
CREATE TABLE IF NOT EXISTS wp_term_relationships (
  object_id INTEGER NOT NULL DEFAULT 0,
  term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
  site_id TEXT NOT NULL,
  term_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_id, term_taxonomy_id, site_id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_comments: 댓글
CREATE TABLE IF NOT EXISTS wp_comments (
  comment_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  comment_post_ID INTEGER NOT NULL DEFAULT 0,
  comment_author TEXT NOT NULL DEFAULT '',
  comment_author_email TEXT NOT NULL DEFAULT '',
  comment_author_url TEXT NOT NULL DEFAULT '',
  comment_author_IP TEXT NOT NULL DEFAULT '',
  comment_date TEXT NOT NULL DEFAULT '',
  comment_date_gmt TEXT NOT NULL DEFAULT '',
  comment_content TEXT NOT NULL DEFAULT '',
  comment_karma INTEGER NOT NULL DEFAULT 0,
  comment_approved TEXT NOT NULL DEFAULT '1',
  comment_agent TEXT NOT NULL DEFAULT '',
  comment_type TEXT NOT NULL DEFAULT 'comment',
  comment_parent INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_commentmeta
CREATE TABLE IF NOT EXISTS wp_commentmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  comment_id INTEGER NOT NULL DEFAULT 0,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- wp_links: 링크 관리
CREATE TABLE IF NOT EXISTS wp_links (
  link_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  link_url TEXT NOT NULL DEFAULT '',
  link_name TEXT NOT NULL DEFAULT '',
  link_image TEXT NOT NULL DEFAULT '',
  link_target TEXT NOT NULL DEFAULT '',
  link_description TEXT NOT NULL DEFAULT '',
  link_visible TEXT NOT NULL DEFAULT 'Y',
  link_owner INTEGER NOT NULL DEFAULT 1,
  link_rating INTEGER NOT NULL DEFAULT 0,
  link_updated TEXT NOT NULL DEFAULT '',
  link_rel TEXT NOT NULL DEFAULT '',
  link_notes TEXT NOT NULL DEFAULT '',
  link_rss TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sites_slug ON sites(site_slug);
CREATE INDEX IF NOT EXISTS idx_jobs_site ON site_jobs(site_id);
CREATE INDEX IF NOT EXISTS idx_pma_token ON phpmyadmin_tokens(token);
CREATE INDEX IF NOT EXISTS idx_pma_site ON phpmyadmin_tokens(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_options_site ON wp_options(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_posts_site ON wp_posts(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_users_site ON wp_users(site_id);
