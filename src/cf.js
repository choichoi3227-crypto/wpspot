// src/cf.js
const CF_API = "https://api.cloudflare.com/client/v4";

function authHeaders(email, globalApiKey) {
  return {
    "X-Auth-Email": email,
    "X-Auth-Key": globalApiKey,
  };
}

// Account ID 자동 조회
export async function getAccountId(email, globalApiKey) {
  const res = await fetch(`${CF_API}/accounts`, {
    headers: { ...authHeaders(email, globalApiKey), "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`Cloudflare 계정 조회 실패: ${res.status} ${JSON.stringify(data.errors)}`);
  }
  if (!data.result || !data.result.length) throw new Error("Cloudflare 계정을 찾을 수 없습니다.");
  return data.result[0].id;
}

// 블로그스팟 ↔ 워드프레스 프록시 워커 배포
export async function deployProxyWorker(email, globalApiKey, accountId, workerName, origin) {
  const script = buildWorkerScript(origin);
  const uploadUrl = `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`;

  // Cloudflare Workers Script Upload API (multipart/form-data)
  // metadata 파트에 반드시 Content-Type: application/json 명시 필요
  const metadataJson = JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2024-09-23",
  });

  // Cloudflare Workers 환경에서 FormData의 Blob에 type을 지정하면
  // fetch가 올바른 multipart boundary를 자동 처리한다.
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([metadataJson], { type: "application/json" }),
    "metadata.json"
  );
  form.append(
    "worker.js",
    new Blob([script], { type: "application/javascript+module" }),
    "worker.js"
  );

  // Content-Type은 fetch가 FormData에서 자동으로 multipart/form-data; boundary=... 로 설정
  // 절대 수동으로 Content-Type 헤더를 추가하면 안 됨 (boundary 파괴)
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: authHeaders(email, globalApiKey),
    body: form,
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`Cloudflare Worker 배포 실패: ${uploadRes.status} ${body}`);
  }

  // workers.dev 서브도메인 활성화
  await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    {
      method: "POST",
      headers: { ...authHeaders(email, globalApiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }
  );

  // 계정 workers.dev 서브도메인 조회
  const subdomain = await getWorkerSubdomain(email, globalApiKey, accountId);
  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function getWorkerSubdomain(email, globalApiKey, accountId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
      headers: { ...authHeaders(email, globalApiKey), "Content-Type": "application/json" },
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

// 프록시 워커 스크립트
function buildWorkerScript(origin) {
  return `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = new URL(${JSON.stringify(origin)});
    target.pathname = url.pathname;
    target.search = url.search;

    const headers = new Headers(request.headers);
    headers.set("host", target.host);

    const init = {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    };

    let resp;
    try {
      resp = await fetch(target.toString(), init);
    } catch (e) {
      // origin이 아직 배포 중이거나 DNS 미준비 상태
      return new Response(buildLoadingHtml(${JSON.stringify(origin)}), {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "30" },
      });
    }

    // Pages 빌드 진행 중(523/524/530) 또는 DNS 에러(1016 등)
    if (resp.status === 523 || resp.status === 524 || resp.status === 530 || resp.status === 404 && resp.headers.get("server") === "cloudflare") {
      return new Response(buildLoadingHtml(${JSON.stringify(origin)}), {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "30" },
      });
    }

    const contentType = resp.headers.get("content-type") || "";

    if (
      contentType.includes("text/html") ||
      contentType.includes("text/css") ||
      contentType.includes("javascript")
    ) {
      let text = await resp.text();
      text = text.split(target.origin).join(url.origin);
      const outHeaders = new Headers(resp.headers);
      outHeaders.delete("content-length");
      const loc = outHeaders.get("location");
      if (loc) outHeaders.set("location", loc.replace(target.origin, url.origin));
      return new Response(text, { status: resp.status, headers: outHeaders });
    }

    const outHeaders = new Headers(resp.headers);
    const loc = outHeaders.get("location");
    if (loc) outHeaders.set("location", loc.replace(target.origin, url.origin));
    return new Response(resp.body, { status: resp.status, headers: outHeaders });
  }
};

function buildLoadingHtml(origin) {
  return \`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>사이트 준비 중 — wpspot</title>
<meta http-equiv="refresh" content="30">
<style>
  body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#334155;}
  .box{text-align:center;max-width:420px;padding:2rem;}
  .spinner{width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1.5rem;}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}
  p{font-size:.9rem;color:#64748b;margin:.5rem 0}
  small{font-size:.75rem;color:#94a3b8}
</style>
</head>
<body>
<div class="box">
  <div class="spinner"></div>
  <h1>사이트를 배포하는 중이에요</h1>
  <p>Cloudflare Pages 초기 배포가 완료되면 자동으로 표시됩니다.<br>보통 1~3분 정도 걸려요.</p>
  <p><small>이 페이지는 30초마다 자동으로 새로고침 됩니다.</small></p>
  <p><small>원본: \${origin}</small></p>
</div>
</body>
</html>\`;
}`;
}
}

