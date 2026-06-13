// src/cf.js
// 사용자가 입력한 Cloudflare Global API Key + 계정 이메일/Account ID로
// "블로그스팟 프록시 워커"를 사용자 자신의 Cloudflare 계정에 생성한다.
// 이 워커는 워드프레스 원본(GitHub Actions가 배포한 nginx+PHP-FPM 서버리스 환경)을
// 블로그스팟 프론트엔드 뒤에서 그대로 서빙하는 역할을 한다.

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

// 블로그스팟 ↔ 워드프레스(nginx/PHP-FPM) 프록시 워커 배포
// 워커는 GitHub Actions로 배포된 사용자의 워드프레스 오리진(예: <repo>.pages.dev 또는
// 외부 nginx 엔드포인트)으로 모든 요청을 그대로 전달(rewrite)한다.
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
  await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    method: "POST",
    headers: cfHeadersJson(email, globalApiKey),
    body: JSON.stringify({ enabled: true }),
  });

  // 계정 서브도메인 조회하여 최종 URL 구성
  const subRes = await fetch(`${CF_API}/accounts/${accountId}/workers/subdomain`, {
    headers: cfHeadersJson(email, globalApiKey),
  });
  let accountSubdomain = accountId;
  if (subRes.ok) {
    const subData = await subRes.json();
    if (subData.result && subData.result.subdomain) accountSubdomain = subData.result.subdomain;
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

// 프록시 워커 스크립트: 모든 요청을 워드프레스 오리진으로 전달하고
// 응답 HTML 내 절대 URL을 현재 블로그스팟 도메인 기준으로 재작성한다.
function buildWorkerScript(origin) {
  return `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = new URL(${JSON.stringify(origin)});
    target.pathname = url.pathname;
    target.search = url.search;

    const init = {
      method: request.method,
      headers: request.headers,
      body: ["GET","HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    };

    const resp = await fetch(target.toString(), init);
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("text/html") || contentType.includes("text/css") || contentType.includes("javascript")) {
      let text = await resp.text();
      // 워드프레스 오리진 절대경로를 현재 접속 도메인으로 재작성
      text = text.split(target.origin).join(url.origin);
      const headers = new Headers(resp.headers);
      headers.delete("content-length");
      return new Response(text, { status: resp.status, headers });
    }

    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }
}`;
}
