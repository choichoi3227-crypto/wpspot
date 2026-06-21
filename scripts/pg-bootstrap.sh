#!/usr/bin/env bash
# scripts/pg-bootstrap.sh
# wpspot 플랫폼 메인 DB(PostgreSQL)를 GitHub Actions 러너 위에서 부팅합니다.
# - Postgres 16 설치 → pg-backup/latest.sql.gz 가 있으면 복원
# - PostgREST로 즉시 REST API 노출 (Worker는 fetch()로만 통신 — 항목 8 "api 통신")
# - cloudflared 터널로 외부에 안정적인 URL 노출
# - D1(KV 백업)에는 worker.js 쪽에서 비동기로 동기화 (이 스크립트의 역할 아님)
#
# 사용처: .github/workflows/postgres-keepalive.yml (5개 job이 offset을 두고 이 스크립트를 호출)
#
# 필요한 GitHub Secrets:
#   PG_PASS            - postgres 'wpspot' 사용자 비밀번호
#   PG_TUNNEL_TOKEN     - 이 Postgres용 cloudflared 터널 토큰 (PostgREST를 노출)
#   PGRST_JWT_SECRET    - PostgREST가 검증할 JWT 시크릿 (worker.js의 PG_API_SECRET과 동일해야 함)
set -uo pipefail

PG_PORT=5432
PGRST_PORT=3001
DB_NAME=wpspot
DB_USER=wpspot
BACKUP_DIR="pg-backup"
BACKUP_FILE="${BACKUP_DIR}/latest.sql.gz"
PGRST_VERSION="v12.2.3"

log() { echo "[pg-bootstrap] $*"; }

install_postgres() {
  if command -v psql >/dev/null 2>&1; then
    log "postgresql 이미 설치됨"
    return
  fi
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends postgresql postgresql-contrib 2>/dev/null
  log "✓ postgresql 설치 완료"
}

start_postgres() {
  sudo systemctl start postgresql
  sleep 2

  sudo -u postgres psql -v ON_ERROR_STOP=0 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${PG_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} PASSWORD '${PG_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
-- PostgREST 익명/인증 역할 (RLS로 보호, 실제 권한은 schema_postgres.sql 에서 부여)
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pgrst_authenticator') THEN
    CREATE ROLE pgrst_authenticator NOINHERIT LOGIN PASSWORD '${PG_PASS}';
    GRANT web_anon TO pgrst_authenticator;
    GRANT ${DB_USER} TO pgrst_authenticator;
  END IF;
END
\$\$;
SQL

  # 127.0.0.1 에서만 비밀번호 인증 허용 (외부는 cloudflared 터널 + PostgREST 만 통과)
  PG_HBA=$(sudo -u postgres psql -tAc "SHOW hba_file;")
  if ! sudo grep -q "wpspot-managed" "$PG_HBA" 2>/dev/null; then
    echo "# wpspot-managed" | sudo tee -a "$PG_HBA" > /dev/null
    echo "host all all 127.0.0.1/32 md5" | sudo tee -a "$PG_HBA" > /dev/null
  fi
  sudo systemctl restart postgresql
  sleep 2

  TABLE_COUNT=$(PGPASSWORD="$PG_PASS" psql -U "$DB_USER" -h 127.0.0.1 -d "$DB_NAME" -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0")

  if [ "$TABLE_COUNT" = "0" ]; then
    if [ -f "$BACKUP_FILE" ]; then
      log "백업에서 복원 중... ($BACKUP_FILE)"
      zcat "$BACKUP_FILE" | PGPASSWORD="$PG_PASS" psql -U "$DB_USER" -h 127.0.0.1 -d "$DB_NAME" -q 2>/dev/null
      log "✓ 복원 완료"
    elif [ -f "schema_postgres.sql" ]; then
      log "백업 없음 — schema_postgres.sql로 초기화"
      PGPASSWORD="$PG_PASS" psql -U "$DB_USER" -h 127.0.0.1 -d "$DB_NAME" -q -f schema_postgres.sql 2>/dev/null
      log "✓ 스키마 초기화 완료"
    fi
  else
    log "✓ 기존 DB 사용 (테이블 ${TABLE_COUNT}개)"
  fi
}

install_postgrest() {
  if command -v postgrest >/dev/null 2>&1; then
    log "postgrest 이미 설치됨"
    return
  fi
  URL="https://github.com/PostgREST/postgrest/releases/download/${PGRST_VERSION}/postgrest-${PGRST_VERSION}-linux-static-x64.tar.xz"
  for _t in 1 2 3; do
    curl -sSL -f "$URL" -o /tmp/postgrest.tar.xz && break
    sleep 5
  done
  tar -xf /tmp/postgrest.tar.xz -C /tmp
  sudo mv /tmp/postgrest /usr/local/bin/postgrest
  sudo chmod +x /usr/local/bin/postgrest
  log "✓ postgrest 설치 완료"
}

start_postgrest() {
  cat > /tmp/postgrest.conf <<CONF
db-uri = "postgres://pgrst_authenticator:${PG_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}"
db-schemas = "public"
db-anon-role = "web_anon"
server-port = ${PGRST_PORT}
server-host = "0.0.0.0"
jwt-secret = "${PGRST_JWT_SECRET}"
CONF
  pkill -f "postgrest /tmp/postgrest.conf" 2>/dev/null || true
  nohup postgrest /tmp/postgrest.conf > /tmp/postgrest.log 2>&1 &
  echo $! > /tmp/postgrest.pid
  sleep 2
  CODE=$(curl -sf -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PGRST_PORT}/" 2>/dev/null || echo "000")
  log "PostgREST 상태: ${CODE}"
}

start_tunnel() {
  if ! command -v cloudflared >/dev/null 2>&1; then
    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
    for _t in 1 2 3; do curl -sSL -f "$CF_URL" -o /tmp/cf.deb && break; sleep 5; done
    dpkg -x /tmp/cf.deb /tmp/cf-pkg && sudo cp /tmp/cf-pkg/usr/bin/cloudflared /usr/local/bin/cloudflared
  fi
  if [ -n "${PG_TUNNEL_TOKEN:-}" ]; then
    pkill -f "cloudflared tunnel" 2>/dev/null || true
    nohup cloudflared tunnel --no-autoupdate run --token "$PG_TUNNEL_TOKEN" \
      --url "http://127.0.0.1:${PGRST_PORT}" --logfile /tmp/cf-pg.log > /tmp/cf-pg.out 2>&1 &
    echo $! > /tmp/cf-pg.pid
    sleep 4
    CONN=$(grep -c "Registered tunnel connection" /tmp/cf-pg.log 2>/dev/null || echo "0")
    log "터널 연결: ${CONN}"
  else
    log "::warning::PG_TUNNEL_TOKEN 시크릿이 없어 터널을 시작하지 않았습니다."
  fi
}

backup_and_push() {
  mkdir -p "$BACKUP_DIR"
  PGPASSWORD="$PG_PASS" pg_dump -U "$DB_USER" -h 127.0.0.1 "$DB_NAME" 2>/dev/null \
    | gzip > "${BACKUP_FILE}.tmp" && mv "${BACKUP_FILE}.tmp" "$BACKUP_FILE"
  git config user.name "wpspot-bot" 2>/dev/null || true
  git config user.email "bot@wpspot.local" 2>/dev/null || true
  git add "$BACKUP_DIR" 2>/dev/null || true
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "chore: postgres backup [${GITHUB_JOB:-keepalive}]" -q && git push -q || true
  fi
}

healthcheck_loop() {
  for tick in 90 90 90; do
    sleep "$tick"
    sudo systemctl is-active postgresql > /dev/null 2>&1 || sudo systemctl restart postgresql
    pgrep -f "postgrest /tmp/postgrest.conf" > /dev/null 2>&1 || start_postgrest
    CODE=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 8 \
      "http://127.0.0.1:${PGRST_PORT}/" 2>/dev/null || echo "000")
    log "헬스체크: ${CODE}"
  done
}

case "${1:-full}" in
  install)  install_postgres; install_postgrest ;;
  start)    start_postgres; start_postgrest; start_tunnel ;;
  backup)   backup_and_push ;;
  loop)     healthcheck_loop ;;
  full)     install_postgres; install_postgrest; start_postgres; start_postgrest; start_tunnel ;;
  *) echo "사용법: $0 {install|start|backup|loop|full}"; exit 1 ;;
esac
