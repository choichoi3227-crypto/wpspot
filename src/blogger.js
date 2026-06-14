// src/blogger.js

const BLOGGER_API = "https://www.googleapis.com/blogger/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function gHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

// ─────────────────────────────────────────────
// OAuth 토큰 자동 갱신
// ─────────────────────────────────────────────

// Refresh Token으로 새 Access Token 발급
export async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`토큰 갱신 실패: ${data.error_description || data.error || res.status}`);
  }
  // { access_token, expires_in (초), token_type }
  return {
    accessToken: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) - 60, // 60초 여유
  };
}

// Authorization Code → Access Token + Refresh Token 교환
export async function exchangeCodeForTokens(clientId, clientSecret, code, redirectUri) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`코드 교환 실패: ${data.error_description || data.error || res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) - 60,
  };
}

// DB에서 유효한 Access Token 가져오기 (만료 시 자동 갱신)
// cred: user_credentials 행, env: Worker env (암호화용), DB: D1, userId: string
export async function getValidAccessToken(cred, env, DB, userId) {
  const { decryptSecret, encryptSecret } = await import("./crypto.js");

  const now = Math.floor(Date.now() / 1000);
  const hasRefresh = !!cred.gcp_blogger_refresh_token_enc;
  const hasClientId = !!cred.gcp_blogger_client_id;
  const hasClientSecret = !!cred.gcp_blogger_client_secret_enc;
  const tokenExpired = !cred.gcp_blogger_token_expires_at || now >= cred.gcp_blogger_token_expires_at;

  // Refresh Token 기반 자동 갱신
  if (hasRefresh && hasClientId && hasClientSecret && tokenExpired) {
    const refreshToken = await decryptSecret(env, cred.gcp_blogger_refresh_token_enc);
    const clientSecret = await decryptSecret(env, cred.gcp_blogger_client_secret_enc);
    const { accessToken, expiresAt } = await refreshAccessToken(
      cred.gcp_blogger_client_id,
      clientSecret,
      refreshToken
    );
    // 새 Access Token을 DB에 저장
    const newEnc = await encryptSecret(env, accessToken);
    await DB.prepare(
      "UPDATE user_credentials SET gcp_blogger_token_enc = ?, gcp_blogger_token_expires_at = ?, updated_at = strftime('%s','now') WHERE user_id = ?"
    ).bind(newEnc, expiresAt, userId).run();
    return accessToken;
  }

  // Access Token만 있는 경우 (만료 여부 무관 — 만료됐으면 API 호출 시 에러)
  if (cred.gcp_blogger_token_enc) {
    return decryptSecret(env, cred.gcp_blogger_token_enc);
  }

  throw new Error("Blogger API 토큰이 등록되어 있지 않습니다. 내 계정에서 Google 계정을 연동해주세요.");
}

// ─────────────────────────────────────────────
// Blogger API
// ─────────────────────────────────────────────

export async function listBlogs(accessToken) {
  const res = await fetch(`${BLOGGER_API}/users/self/blogs`, { headers: gHeaders(accessToken) });
  if (!res.ok) throw new Error(`Blogger 블로그 목록 조회 실패: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

export async function getBlog(accessToken, blogId) {
  const res = await fetch(`${BLOGGER_API}/blogs/${blogId}`, { headers: gHeaders(accessToken) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blogger 블로그 접근 실패 (Blog ID: ${blogId}): ${res.status} ${text}`);
  }
  return res.json();
}

export async function createPost(accessToken, blogId, title, content) {
  const res = await fetch(`${BLOGGER_API}/blogs/${blogId}/posts`, {
    method: "POST",
    headers: gHeaders(accessToken),
    body: JSON.stringify({ kind: "blogger#post", title, content }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blogger 게시물 생성 실패: ${res.status} ${text}`);
  }
  return res.json();
}

export async function setProxyTemplate(accessToken, blogId, workerUrl) {
  // 블로그 존재 및 권한 확인
  const blog = await getBlog(accessToken, blogId);
  const xml = buildProxyTemplateXml(workerUrl);

  // Blogger API v3: 템플릿 직접 적용
  const res = await fetch(`${BLOGGER_API}/blogs/${blogId}/templates/blogger`, {
    method: "PATCH",
    headers: gHeaders(accessToken),
    body: JSON.stringify({ template: xml }),
  });

  if (!res.ok) {
    const text = await res.text();
    // 권한 오류 등 실패해도 계속 진행 (수동 적용 안내)
    console.warn(`Blogger 템플릿 자동 적용 실패 (${res.status}): ${text}`);
    return {
      xml,
      blogUrl: blog.url,
      templateApplied: false,
      note: `템플릿 자동 적용 실패 (${res.status}). 블로그스팟 대시보드 → 테마 → HTML 편집에서 아래 XML을 붙여넣기 해주세요.`,
    };
  }

  return {
    xml,
    blogUrl: blog.url,
    templateApplied: true,
    note: "블로그스팟 템플릿이 자동 적용됐습니다.",
  };
}

function buildProxyTemplateXml(workerUrl) {
  const escapedUrl = workerUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8" ?>
<html xmlns='http://www.w3.org/1999/xhtml'
      xmlns:b='http://www.google.com/2005/gml/b'
      xmlns:data='http://www.google.com/2005/gml/data'
      xmlns:expr='http://www.google.com/2005/gml/expr'>
<head>
  <meta charset='utf-8'/>
  <meta name='viewport' content='width=device-width, initial-scale=1'/>
  <title><data:blog.pageTitle/></title>
  <b:skin><![CDATA[
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    #wpspot-frame { border: 0; width: 100%; height: 100vh; display: block; }
  ]]></b:skin>
</head>
<body>
  <b:section id='wpspot-root' showaddelement='no'>
    <b:widget id='WPSpotProxy1' type='HTML' version='2' locked='true'>
      <b:widget-settings>
        <b:widget-setting name='content'>
          <![CDATA[
            <iframe id="wpspot-frame" src="${escapedUrl}" title="wpspot"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
            <script>
              (function() {
                var base = ${JSON.stringify(workerUrl)};
                var frame = document.getElementById('wpspot-frame');
                function sync() {
                  if (frame) frame.src = base + window.location.pathname + window.location.search + window.location.hash;
                }
                sync();
                window.addEventListener('popstate', sync);
              })();
            </script>
          ]]>
        </b:widget-setting>
      </b:widget-settings>
      <b:includable id='content'>
        <div class='widget-content'><data:widget.content/></div>
      </b:includable>
    </b:widget>
  </b:section>
</body>
</html>`;
}


