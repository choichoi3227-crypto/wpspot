-- wpspot D1 schema migration v10
-- 항목 1: 누락 API(/api/admin/*, /api/notices, /api/billing/invoices, /api/payment/*)가
--         의존하는 테이블/컬럼 추가
-- 항목 6: 관리자(is_admin=1)는 플랜 제한 없이 무제한으로 사이트를 생성할 수 있음
-- 항목 9: site_credentials는 이미 존재 — 여기서는 admin/billing/notice 관련만 추가

-- 사용자: 관리자 플래그, 구독 플랜, 활성 상태
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'light';
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- 사이트별 플랜(스케일링 슬라이더에서 변경 가능, 기본값은 가입 시 사용자의 plan 상속)
ALTER TABLE sites ADD COLUMN plan TEXT NOT NULL DEFAULT 'light';

-- 공지사항 (대시보드 상단/알림용)
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info', -- 'info' | 'warn' | 'success'
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 결제 수단 (카드 / PayPal)
CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'card', -- 'card' | 'paypal'
  brand TEXT,
  last4 TEXT,
  paypal_email TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 청구/인보이스 내역
CREATE TABLE IF NOT EXISTS billing_invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'paid', -- 'paid' | 'pending' | 'failed'
  year TEXT NOT NULL,
  month TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_user_year ON billing_invoices(user_id, year);

-- 운영자 계정 본인을 관리자로 승격하려면 가입 후 아래를 수동 실행하세요:
-- UPDATE users SET is_admin = 1 WHERE email = '본인이메일@example.com';
