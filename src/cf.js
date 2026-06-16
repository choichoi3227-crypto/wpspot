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

// DNS 레코드 수정
export async function updateDnsRecord(email, globalApiKey, zoneId, recordId, record) {
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
    method: "PATCH",
    headers: authHeaders(email, globalApiKey),
    body: JSON.stringify(record),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`DNS 레코드 수정 실패: ${JSON.stringify(data.errors)}`);
  return data.result;
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

// 단일 파일 Worker를 Cloudflare API로 직접 배포 (wrangler 불필요, ES module worker)
export async function deployModuleWorker(email, globalApiKey, accountId, scriptName, jsContent) {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2024-09-23",
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("worker.js", new Blob([jsContent], { type: "application/javascript+module" }), "worker.js");

  const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    headers: { "X-Auth-Email": email, "X-Auth-Key": globalApiKey }, // Content-Type은 FormData가 boundary 포함해 자동 설정
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(`Worker 배포 실패 (${scriptName}): ${JSON.stringify(data.errors || data)}`);
  return data.result;
}

// ── Cloudflare Cache 제거 ──────────────────────────────────────────────────

// Worker Route가 매칭되려면 해당 호스트명에 proxied DNS 레코드가 존재해야 함.
// 실제 origin은 Worker가 처리하므로 더미 IP(192.0.2.1, TEST-NET-1)를 사용.
export async function ensureProxiedRecord(email, globalApiKey, zoneId, hostname) {
  const records = await listDnsRecords(email, globalApiKey, zoneId);
  const existing = records.find(r => r.name === hostname && (r.type === "A" || r.type === "CNAME"));
  if (existing) {
    if (!existing.proxied) {
      await updateDnsRecord(email, globalApiKey, zoneId, existing.id, {
        type: existing.type, name: hostname, content: existing.content, proxied: true, ttl: 1,
      });
    }
    return existing;
  }
  return await createDnsRecord(email, globalApiKey, zoneId, {
    type: "A", name: hostname, content: "192.0.2.1", proxied: true, ttl: 1,
  });
}

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
