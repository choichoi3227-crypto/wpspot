// src/cf.js — Cloudflare API 유틸리티 (블로그스팟 제거)
const CF_API = "https://api.cloudflare.com/client/v4";

function authHeaders(email, globalApiKey) {
  return {
    "X-Auth-Email": email,
    "X-Auth-Key": globalApiKey,
    "Content-Type": "application/json",
  };
}

function tokenHeaders(apiToken) {
  return {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

// Account ID 자동 조회
export async function getAccountId(email, globalApiKey) {
  const res = await fetch(`${CF_API}/accounts`, {
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`Cloudflare 계정 조회 실패: ${res.status} ${JSON.stringify(data.errors)}`);
  }
  if (!data.result || !data.result.length) throw new Error("Cloudflare 계정을 찾을 수 없습니다.");
  return data.result[0].id;
}

// workers.dev 서브도메인 조회
export async function getWorkerSubdomain(email, globalApiKey, accountId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
      headers: authHeaders(email, globalApiKey),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.result?.subdomain) return data.result.subdomain;
    }
  }
  throw new Error(
    "Cloudflare workers.dev 서브도메인을 확인할 수 없습니다. " +
    "Cloudflare 대시보드 → Workers & Pages → 서브도메인을 먼저 설정해주세요."
  );
}

// ── 도메인 (Zone) 관리 ─────────────────────────────────────────────────────

// 도메인 목록 조회
export async function listZones(email, globalApiKey) {
  const res = await fetch(`${CF_API}/zones?per_page=100`, {
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`Zone 목록 조회 실패: ${JSON.stringify(data.errors)}`);
  return data.result || [];
}

// 도메인 추가 (네임서버 위임 방식)
export async function addZone(email, globalApiKey, accountId, domainName) {
  const res = await fetch(`${CF_API}/zones`, {
    method: "POST",
    headers: authHeaders(email, globalApiKey),
    body: JSON.stringify({
      name: domainName,
      account: { id: accountId },
      jump_start: false,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`Zone 추가 실패: ${JSON.stringify(data.errors)}`);
  return data.result; // { id, name, name_servers, status }
}

// Zone 상태 조회
export async function getZone(email, globalApiKey, zoneId) {
  const res = await fetch(`${CF_API}/zones/${zoneId}`, {
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`Zone 조회 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// Zone 삭제
export async function deleteZone(email, globalApiKey, zoneId) {
  const res = await fetch(`${CF_API}/zones/${zoneId}`, {
    method: "DELETE",
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`Zone 삭제 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// ── DNS 레코드 관리 ────────────────────────────────────────────────────────

// DNS 레코드 목록
export async function listDnsRecords(email, globalApiKey, zoneId) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records?per_page=100`, {
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`DNS 레코드 조회 실패: ${JSON.stringify(data.errors)}`);
  return data.result || [];
}

// DNS 레코드 추가
export async function createDnsRecord(email, globalApiKey, zoneId, record) {
  // record: { type, name, content, ttl, proxied }
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: authHeaders(email, globalApiKey),
    body: JSON.stringify(record),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`DNS 레코드 추가 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// DNS 레코드 수정 — PATCH가 read-only 오류(1043)를 낼 수 있으므로
// PUT 시도 → 실패 시 삭제 후 재생성(delete + create) 패턴으로 폴백
export async function updateDnsRecord(email, globalApiKey, zoneId, recordId, record) {
  const headers = authHeaders(email, globalApiKey);
  const url = `${CF_API}/zones/${zoneId}/dns_records/${recordId}`;

  // 1) 기존 레코드 조회 (재생성 시 필드 보존용)
  const getRes = await fetch(url, { headers });
  const getData = await getRes.json();
  const existing = getData.result || {};

  // 2) PUT 시도 (PATCH보다 더 넓은 권한으로 허용되는 경우 있음)
  const putBody = { ...existing, ...record };
  // PUT에 불필요한 read-only 서버 필드 제거
  for (const k of ["id", "zone_id", "zone_name", "created_on", "modified_on", "meta", "locked"]) {
    delete putBody[k];
  }
  const putRes = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(putBody),
  });
  const putData = await putRes.json();
  if (putRes.ok && putData.success) return putData.result;

  // 3) PUT도 1043(read-only) 또는 기타 실패 → 삭제 후 재생성
  const isReadOnly = (putData.errors || []).some(e => e.code === 1043);
  const isNotAllowed = !putRes.ok;
  if (isReadOnly || isNotAllowed) {
    // 삭제
    const delRes = await fetch(url, { method: "DELETE", headers });
    const delData = await delRes.json();
    if (!delRes.ok || !delData.success) {
      throw new Error(`DNS 레코드 삭제 실패(재생성 준비 중): ${JSON.stringify(delData.errors)}`);
    }
    // 재생성
    const createBody = { ...existing, ...record };
    for (const k of ["id", "zone_id", "zone_name", "created_on", "modified_on", "meta", "locked"]) {
      delete createBody[k];
    }
    const createRes = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers,
      body: JSON.stringify(createBody),
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData.success) {
      throw new Error(`DNS 레코드 재생성 실패: ${JSON.stringify(createData.errors)}`);
    }
    return createData.result;
  }

  throw new Error(`DNS 레코드 수정 실패: ${JSON.stringify(putData.errors)}`);
}

// DNS 레코드 삭제
export async function deleteDnsRecord(email, globalApiKey, zoneId, recordId) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
    method: "DELETE",
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`DNS 레코드 삭제 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// ── Worker Route (alias: CF Worker의 Custom Domain) ────────────────────────

// Worker에 Custom Domain(route) 추가 — alias 기능
export async function addWorkerRoute(email, globalApiKey, zoneId, pattern, workerName) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/workers/routes`, {
    method: "POST",
    headers: authHeaders(email, globalApiKey),
    body: JSON.stringify({ pattern, script: workerName }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`Worker Route 추가 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// Worker Route 목록
export async function listWorkerRoutes(email, globalApiKey, zoneId) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/workers/routes`, {
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`Worker Route 목록 조회 실패: ${JSON.stringify(data.errors)}`);
  return data.result || [];
}

// Worker Route 삭제
export async function deleteWorkerRoute(email, globalApiKey, zoneId, routeId) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/workers/routes/${routeId}`, {
    method: "DELETE",
    headers: authHeaders(email, globalApiKey),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`Worker Route 삭제 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// ── Cloudflare Cache 제거 ──────────────────────────────────────────────────

// 특정 Zone의 캐시 전체 퍼지
export async function purgeCache(email, globalApiKey, zoneId) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/purge_cache`, {
    method: "POST",
    headers: authHeaders(email, globalApiKey),
    body: JSON.stringify({ purge_everything: true }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`캐시 퍼지 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
}
