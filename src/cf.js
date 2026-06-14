// src/cf.js
// 사용자가 입력한 Cloudflare Global API Key + 계정 이메일/Account ID로
// "블로그스팟 프록시 워커"를 사용자 자신의 Cloudflare 계정에 생성한다.

const CF_API = "https://api.cloudflare.com/client/v4";

function cfHeaders(email, globalApiKey) {
  return {
    "X-Auth-Email": email,
    "X-Auth-Key": globalApiKey,
    "Content-Type": "application/javascript",
  };
}

function cfHeadersJson(email, globalApiKey) {
  return {
    "X-Auth-Email": email,
    "X-Auth-Key": globalApiKey,
    "Content-Type": "application/json",
  };
}

// Account ID 자동 조회 (입력 안 한 경우)
export async function getAccountId(email, globalApiKey) {
  const res = await fetch(`${CF_API}/accounts`, { headers: cfHeadersJson(email, globalApiKey) });
  if (!res.ok) throw new Error(`Cloudflare 계정 조회 실패: ${res.status}`);
  const data = await res.json();
  if (!data.result || !data.result.length) throw new Error("Cloudflare 계정을 찾을 수 없습니다.");
  return data.result[0].id;
}

// 블로그스팟 ↔ 워드프레스 프록시 워커 배포
export async function deployProxyWorker(email, globalApiKey, accountId, workerName, origin) {
  const script = buildWorkerScript(origin);
  const url = `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`;

  const formData = await buildModuleUploadBody(script);

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Auth-Email": email,
      "X-Auth-Key": globalApiKey,
    },
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare Worker 배포 실패: ${res.status} ${text}`);
  }

  // workers.dev 서브도메인 활성화
  const subdomainRes = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    {
      method: "POST",
      headers: cfHeadersJson(email, globalApiKey),
      body: JSON.stringify({ enabled: true }),
    }
  );
  if (!subdomainRes.ok) {
    // 이미 활성화된 경우 무시
    const body = await subdomainRes.json().catch(() => ({}));
    if (!body?.errors?.some((e) => e.code === 10067)) {
      // 10067 = already enabled, 그 외 에러는 로그만
      console.warn("subdomain 활성화 응답:", subdomainRes.status, JSON.stringify(body));
    }
  }

  // 계정 서브도메인 조회 (올바른 엔드포인트 사용)
  const subRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
    headers: cfHeadersJson(email, globalApiKey),
  });
  let accountSubdomain = null;
  if (subRes.ok) {
    const subData = await subRes.json();
    if (subData.result && subData.result.subdomain) {
      accountSubdomain = subData.result.subdomain;
    }
  }

  // 서브도메인 조회 실패 시 Account ID로 폴백 후 재시도 (최초 활성화 직후 지연 발생 가능)
  if (!accountSubdomain) {
    await new Promise((r) => setTimeout(r, 2000));
    const retryRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
      headers: cfHeadersJson(email, globalApiKey),
    });
    if (retryRes.ok) {
      const retryData = await retryRes.json();
      accountSubdomain = retryData.result?.subdomain || null;
    }
  }

  if (!accountSubdomain) {
    throw new Error(
      "Cloudflare workers.dev 서브도메인을 확인할 수 없습니다. " +
        "Cloudflare 대시보드 → Workers & Pages → 서브도메인을 먼저 설정해주세요."
    );
  }

  return `https://${workerName}.${accountSubdomain}.workers.dev`;
}

async function buildModuleUploadBody(script) {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2024-09-23",
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append(
    "worker.js",
    new Blob([script], { type: "application/javascript+module" }),
    "worker.js"
  );
  return form;
}

// 프록시 워커 스크립트
function buildWorkerScript(origin) {
  return `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = new URL(${JSON.stringify(origin)});
    target.pathname = url.pathname;
    target.search = url.search;

    const init = {
      method: request.method,
      headers: new Headers(request.headers),
      body: ["GET","HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    };
    // Host 헤더를 오리진으로 맞춤 (일부 서버가 Host 검증)
    init.headers.set("host", target.host);

    const resp = await fetch(target.toString(), init);
    const contentType = resp.headers.get("content-type") || "";

    if (
      contentType.includes("text/html") ||
      contentType.includes("text/css") ||
      contentType.includes("javascript")
    ) {
      let text = await resp.text();
      // 오리진 절대경로를 현재 접속 도메인으로 재작성
      text = text.split(target.origin).join(url.origin);
      const headers = new Headers(resp.headers);
      headers.delete("content-length");
      // location 헤더(리다이렉트) 재작성
      const location = headers.get("location");
      if (location) {
        headers.set("location", location.replace(target.origin, url.origin));
      }
      return new Response(text, { status: resp.status, headers });
    }

    // 바이너리/스트림 응답 그대로 전달
    const headers = new Headers(resp.headers);
    const location = headers.get("location");
    if (location) {
      headers.set("location", location.replace(target.origin, url.origin));
    }
    return new Response(resp.body, { status: resp.status, headers });
  }
}`;
}
