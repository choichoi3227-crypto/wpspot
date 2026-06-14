#!/usr/bin/env node
// scripts/blogger-sync.js
// wpspot Sync 워크플로우에서 실행되는 스크립트.
// Blogger API(v3)로 블로그 정보를 조회하고, 블로그스팟 템플릿을
// "워드프레스형" 프록시 워커(Cloudflare Worker)로 위임하는 XML 템플릿으로 갱신한다.
//
// 필요한 환경변수:
//   GCP_BLOGGER_TOKEN  - Blogger API OAuth Access Token (blogger 스코프)
//   BLOG_ID            - Blogspot Blog ID
//   WORKER_URL         - 블로그스팟 프록시용 Cloudflare Worker URL

const BLOGGER_API = "https://www.googleapis.com/blogger/v3";

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

async function main() {
  const token = process.env.GCP_BLOGGER_TOKEN;
  const blogId = process.env.BLOG_ID;
  const workerUrl = process.env.WORKER_URL;

  if (!token || !blogId || !workerUrl) {
    console.log("GCP_BLOGGER_TOKEN, BLOG_ID, WORKER_URL 중 누락된 값이 있어 동기화를 건너뜁니다.");
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 1) 블로그 정보 확인
  const blogRes = await fetch(`${BLOGGER_API}/blogs/${blogId}`, { headers });
  if (!blogRes.ok) {
    throw new Error(`Blogger 블로그 조회 실패: ${blogRes.status} ${await blogRes.text()}`);
  }
  const blog = await blogRes.json();
  console.log(`연동 대상 블로그: ${blog.name} (${blog.url})`);

  // 2) 블로그스팟 템플릿 적용 (프록시 워커로 리디렉션)
  console.log(`블로그스팟 템플릿 적용 중... (워커: ${workerUrl})`);
  const xml = buildProxyTemplateXml(workerUrl);
  const tplRes = await fetch(`${BLOGGER_API}/blogs/${blogId}/templates/blogger`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ template: xml }),
  });

  if (tplRes.ok) {
    console.log("블로그스팟 템플릿 적용 완료.");
  } else {
    const errText = await tplRes.text();
    console.warn(`블로그스팟 템플릿 자동 적용 실패 (${tplRes.status}): ${errText}`);
    console.warn("블로그스팟 대시보드 → 테마 → HTML 편집에서 수동으로 템플릿을 붙여넣기 해주세요.");
  }

  // 3) 최근 게시물 수 확인
  const postsRes = await fetch(`${BLOGGER_API}/blogs/${blogId}/posts?maxResults=1`, { headers });
  if (postsRes.ok) {
    const posts = await postsRes.json();
    console.log(`최근 게시물 수: ${posts.items ? posts.items.length : 0}`);
  }

  // 4) 워커로 핑을 보내 프록시가 정상 응답하는지 확인
  const pingRes = await fetch(workerUrl, { method: "GET" });
  console.log(`프록시 워커 상태: ${pingRes.status}`);

  console.log("동기화 완료. 블로그스팟 프론트엔드는 프록시 워커를 통해 워드프레스 콘텐츠를 표시합니다.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
