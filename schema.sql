-- wpspot D1 schema v4

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY,
  github_token_enc TEXT,
  github_token_invalid INTEGER NOT NULL DEFAULT 0,
  cf_global_api_key_enc TEXT,
  cf_api_token_enc TEXT,
  cf_account_email TEXT,
  cf_account_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site_name TEXT NOT NULL,
  site_slug TEXT NOT NULL,
  github_repo TEXT,
  cf_worker_name TEXT,
  cf_worker_url TEXT,
  tunnel_pla_url TEXT,
  cf_zone_id TEXT,
  custom_domain TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

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

CREATE TABLE IF NOT EXISTS site_credentials (
  site_id TEXT PRIMARY KEY,
  pla_username TEXT NOT NULL DEFAULT 'admin', -- legacy alias for pma_username
  pla_password_hash TEXT NOT NULL DEFAULT '', -- legacy alias for pma_password_hash
  pla_password_plain_enc TEXT,                -- legacy alias for pma_password_plain_enc
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
  redis_enabled INTEGER NOT NULL DEFAULT 1,
  redis_provider TEXT DEFAULT 'Redis 7 (로컬, 무료)',
  stack TEXT DEFAULT 'nginx+php-fpm+mariadb+redis7',
  php_fpm_main_port TEXT DEFAULT '9000',
  php_fpm_sub_port TEXT DEFAULT '9001',
  php_main_ports TEXT DEFAULT '8080',
  php_sub_ports TEXT DEFAULT '8081',
  php_active_ports TEXT DEFAULT '8080,8081',
  nginx_wp_port TEXT DEFAULT '8080',
  nginx_pma_port TEXT DEFAULT '8081',
  db_backup_path TEXT DEFAULT 'wordpress/db-backup/latest.sql.gz',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);


CREATE TABLE IF NOT EXISTS pma_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS pla_tokens (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

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

-- 사이트 ↔ 도메인 매핑 (Cloudways 스타일 Primary/Alias 멀티 도메인)
CREATE TABLE IF NOT EXISTS site_domain_bindings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  cf_zone_id TEXT NOT NULL,
  hostname TEXT NOT NULL,              -- 예: example.com, www.example.com, blog.example.com
  role TEXT NOT NULL DEFAULT 'alias',  -- 'primary' | 'alias'
  redirect_to_primary INTEGER NOT NULL DEFAULT 0,  -- alias를 primary로 301 리다이렉트할지
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | error
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(hostname),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- 레거시 D1 WordPress 호환 뷰 (실제 호스팅 DB는 MariaDB/MySQL + phpMyAdmin)
CREATE TABLE IF NOT EXISTS wp_options (
  option_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  option_name TEXT NOT NULL,
  option_value TEXT NOT NULL DEFAULT '',
  autoload TEXT NOT NULL DEFAULT 'yes',
  UNIQUE(site_id, option_name),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS wp_users (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_pass TEXT NOT NULL,
  user_nicename TEXT NOT NULL DEFAULT '',
  user_email TEXT NOT NULL DEFAULT '',
  user_url TEXT NOT NULL DEFAULT '',
  user_registered TEXT NOT NULL DEFAULT '',
  user_activation_key TEXT NOT NULL DEFAULT '',
  user_status INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS wp_usermeta (
  umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS wp_posts (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  post_author INTEGER NOT NULL DEFAULT 0,
  post_date TEXT NOT NULL DEFAULT '',
  post_date_gmt TEXT NOT NULL DEFAULT '',
  post_content TEXT NOT NULL DEFAULT '',
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
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS wp_postmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS wp_terms (
  term_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  term_group INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

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

CREATE TABLE IF NOT EXISTS wp_term_relationships (
  object_id INTEGER NOT NULL DEFAULT 0,
  term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
  site_id TEXT NOT NULL,
  term_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_id, term_taxonomy_id, site_id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

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

CREATE TABLE IF NOT EXISTS wp_commentmeta (
  meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  comment_id INTEGER NOT NULL DEFAULT 0,
  meta_key TEXT,
  meta_value TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

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

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_sites_user        ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sites_slug        ON sites(site_slug);
CREATE INDEX IF NOT EXISTS idx_jobs_site         ON site_jobs(site_id);
CREATE INDEX IF NOT EXISTS idx_pma_token         ON pma_tokens(token);
CREATE INDEX IF NOT EXISTS idx_pma_site          ON pma_tokens(site_id);
CREATE INDEX IF NOT EXISTS idx_pla_token         ON pla_tokens(token);
CREATE INDEX IF NOT EXISTS idx_pla_site          ON pla_tokens(site_id);
CREATE INDEX IF NOT EXISTS idx_domains_user      ON site_domains(user_id);
CREATE INDEX IF NOT EXISTS idx_bindings_site      ON site_domain_bindings(site_id);
CREATE INDEX IF NOT EXISTS idx_bindings_hostname  ON site_domain_bindings(hostname);
CREATE INDEX IF NOT EXISTS idx_wp_options_site   ON wp_options(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_posts_site     ON wp_posts(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_users_site     ON wp_users(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_postmeta_site  ON wp_postmeta(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_comments_site  ON wp_comments(site_id);
