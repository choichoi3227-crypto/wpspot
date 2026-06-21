// src/pg.js
// Cloudflare Worker는 raw TCP Postgres 프로토콜을 직접 쓸 수 없으므로,
// GitHub Actions 러너 위에서 띄운 PostgREST(HTTP REST API)에 fetch()로 통신합니다.
// (항목 8: "postgresql 관리 페이지 — api 통신")
//
// 필요한 Worker 환경변수/시크릿:
//   PG_API_URL    - cloudflared 터널이 노출한 PostgREST URL (예: https://pg.cloud-press.co.kr)
//   PG_API_SECRET - scripts/pg-bootstrap.sh 의 PGRST_JWT_SECRET과 동일한 HS256 시크릿
//
// PG_API_URL이 설정되지 않은 환경(로컬 개발, 마이그레이션 전)에서는 모든 함수가
// 조용히 null을 반환하고 호출부는 D1만 사용하도록 설계했습니다 — 기존 동작을 깨지 않습니다.

function pgConfigured(env) {
  return !!(env.PG_API_URL && env.PG_API_SECRET);
}

// PostgREST가 검증할 짧은 수명의 HS256 JWT를 만듭니다 (role: wpspot).
async function signPgJwt(secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { role: "wpspot", exp: Math.floor(Date.now() / 1000) + 60 };
  const b64 = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const data = `${b64(header)}.${b64(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${sigB64}`;
}

async function pgFetch(env, path, options = {}) {
  if (!pgConfigured(env)) return null;
  try {
    const token = await signPgJwt(env.PG_API_SECRET);
    const res = await fetch(`${env.PG_API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Prefer: options.prefer || "return=representation",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("pgFetch 실패", res.status, text);
      return { ok: false, status: res.status, error: text };
    }
    const data = await res.json().catch(() => null);
    return { ok: true, data };
  } catch (e) {
    console.error("pgFetch 예외 (Postgres 다운/터널 끊김 가능)", e.message);
    return { ok: false, status: 0, error: e.message };
  }
}

/** SELECT — PostgREST 필터 문법(eq.value 등) 그대로 사용 */
async function pgSelect(env, table, query = "") {
  return pgFetch(env, `/${table}${query ? "?" + query : ""}`, { method: "GET" });
}

async function pgInsert(env, table, row) {
  return pgFetch(env, `/${table}`, { method: "POST", body: JSON.stringify(row) });
}

async function pgUpdate(env, table, query, patch) {
  return pgFetch(env, `/${table}?${query}`, { method: "PATCH", body: JSON.stringify(patch) });
}

async function pgDelete(env, table, query) {
  return pgFetch(env, `/${table}?${query}`, { method: "DELETE" });
}

/** 헬스체크 — 관리자 DB 관리 페이지에서 사용 */
async function pgHealth(env) {
  if (!pgConfigured(env)) return { configured: false, online: false };
  const res = await pgFetch(env, "/users?select=id&limit=1");
  return { configured: true, online: !!res?.ok, error: res?.ok ? null : res?.error };
}

/**
 * 메인(Postgres) + 서브(D1) 듀얼 라이트.
 * Postgres가 메인이지만, 터널/러너가 내려가 있을 수 있으므로 실패해도 throw 하지 않고
 * D1 쓰기(호출부에서 이미 수행)만으로 서비스가 계속되도록 합니다.
 * 반환값의 pgWritten으로 관리자 페이지에서 동기화 상태를 보여줄 수 있습니다.
 */
async function dualWriteInsert(env, table, row) {
  if (!pgConfigured(env)) return { pgWritten: false, reason: "not_configured" };
  const res = await pgInsert(env, table, row);
  return { pgWritten: !!res?.ok, reason: res?.ok ? null : (res?.error || "unreachable") };
}

export { pgConfigured, pgSelect, pgInsert, pgUpdate, pgDelete, pgHealth, dualWriteInsert };
