// src/blogger.js
// 사용자가 입력한 GCP(Blogger API) OAuth Access Token으로
// 블로그스팟 블로그를 조회하고, 워드프레스 프록시 워커를 가리키는 템플릿을
// 블로그스팟에 적용한다.

const BLOGGER_API = "https://www.googleapis.com/blogger/v3";

function gHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

// 사용자의 블로그 목록 조회
export async function listBlogs(accessToken) {
  const res = await fetch(`${BLOGGER_API}/users/self/blogs`, { headers: gHeaders(accessToken) });
  if (!res.ok) throw new Error(`Blogger 블로그 목록 조회 실패: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

export async function getBlog(accessToken, blogId) {
  const res = await fetch(`${BLOGGER_API}/blogs/${blogId}`, { headers: gHeaders(accessToken) });
  if (!res.ok) throw new Error(`Blogger 블로그 조회 실패: ${res.status}`);
  return res.json();
}

// Blogger API v3 게시물 생성
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

// 블로그스팟 템플릿을 워드프레스 프록시 워커로 위임하는 템플릿으로 교체.
// Blogger API v3는 템플릿을 직접 PUT으로 수정할 수 없으므로
// 실질적인 템플릿 적용은 sync 워크플로우의 blogger-sync.js가 담당한다.
// 여기서는 워커 URL과 생성된 XML을 반환한다.
export async function setProxyTemplate(accessToken, blogId, workerUrl) {
  // 블로그 존재 여부 및 접근 권한 확인
  const blogRes = await fetch(`${BLOGGER_API}/blogs/${blogId}`, {
    headers: gHeaders(accessToken),
  });
  if (!blogRes.ok) {
    const text = await blogRes.text();
    throw new Error(`Blogger 블로그 접근 실패 (Blog ID: ${blogId}): ${blogRes.status} ${text}`);
  }
  const blog = await blogRes.json();

  // 템플릿 API 접근 시도 (v3에서 지원 범위 제한적 — 에러 무시)
  const tplRes = await fetch(`${BLOGGER_API}/blogs/${blogId}/templates/blogger`, {
    headers: gHeaders(accessToken),
  });
  // 404/403은 일반적 — v3 템플릿 API는 제한적으로 제공됨

  const xml = buildProxyTemplateXml(workerUrl);

  return {
    xml,
    blogUrl: blog.url,
    note: "템플릿은 sync 워크플로우(blogger-sync.js)를 통해 적용됩니다. GitHub 레포 Secrets에 GCP_BLOGGER_TOKEN과 CF_WORKER_URL을 설정하면 자동으로 동기화됩니다.",
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
            <iframe id="wpspot-frame" src="${escapedUrl}" title="wpspot" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
            <script>
              (function() {
                var workerBase = ${JSON.stringify(workerUrl)};
                var path = window.location.pathname + window.location.search + window.location.hash;
                var frame = document.getElementById('wpspot-frame');
                if (frame) frame.src = workerBase + path;
                // 팝스테이트/해시체인지 시 동기화
                window.addEventListener('popstate', function() {
                  if (frame) frame.src = workerBase + window.location.pathname + window.location.search + window.location.hash;
                });
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
