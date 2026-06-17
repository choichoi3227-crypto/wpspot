-- schema migration v7 — GitHub Token 유효성 플래그 추가
-- 실행: wrangler d1 execute <DB_NAME> --file=schema_migration_v7.sql
--
-- 배경: 등록 시점에는 유효했던 GitHub Token이 이후 만료/취소되면, 프로비저닝 시점에야
-- "401 Bad credentials"로 드러났음. 이 플래그를 세워서 계정 화면에서 바로 보이게 한다.

ALTER TABLE user_credentials ADD COLUMN github_token_invalid INTEGER NOT NULL DEFAULT 0;
