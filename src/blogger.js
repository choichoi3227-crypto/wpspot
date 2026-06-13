// src/blogger.js
// 사용자가 입력한 GCP(Blogger API) OAuth Access Token으로
// 블로그스팟 블로그를 조회/생성하고, 워드프레스 프록시 워커를 가리키는
// iframe 기반 템플릿을 블로그스팟에 주입한다.
// (블로그스팟은 "프론트엔드"로만 사용 — 99.9% 백엔드는 워드프레스/Worker가 처리)

const BLOGGER_API = "https://www.googleapis.com/blogger/v3";

function gHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

// 사용자의 블로그 목록 조회 (블로그 ID 선택용)
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

// 블로그스팟 템플릿을 워드프레스 프록시 워커로 전체 위임하는 템플릿으로 교체.
// 워커가 모든 경로(/, /wp-admin/*, /wp-json/* 등)를 처리하므로
// 블로그스팟 쪽 템플릿은 단순 fetch-rewrite 셸 역할만 한다.
export async function setProxyTemplate(accessToken, blogId, workerUrl) {
  const xml = buildProxyTemplateXml(workerUrl);
  const res = await fetch(`${BLOGGER_API}/blogs/${blogId}/template`, {
    headers: gHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`Blogger 템플릿 조회 실패: ${res.status}`);

  const putRes = await fetch(`${BLOGGER_API}/blogs/${blogId}/template`, {
    method: "PUT",
    headers: gHeaders(accessToken),
    body: JSON.stringify({ kind: "blogger#template", templateUrl: undefined }),
  });
  // PUT /template (raw)은 v3에서 직접 지원하지 않으므로
  // GitHub Actions의 blogger-sync.js가 Blogger Templates UI 호환 방식(legacy v2 API or
  // 수동 위젯 갱신)으로 처리한다. 여기서는 워커 URL을 D1에 저장하고
  // sync.yml 워크플로우에서 blogger-sync.js를 실행해 적용한다.
  return { xml, note: "워커 URL은 sync 워크플로우에서 blogger-sync.js를 통해 적용됩니다." };
}

function buildProxyTemplateXml(workerUrl) {
  // 모든 요청을 워드프레스 프록시 워커로 위임하는 최소 셸 템플릿
  return `<?xml version="1.0" encoding="UTF-8" ?>
<html xmlns='http://www.w3.org/1999/xhtml' xmlns:b='http://www.google.com/2005/gml/b' xmlns:data='http://www.google.com/2005/gml/data'>
<head>
  <meta charset='utf-8'/>
  <meta name='viewport' content='width=device-width, initial-scale=1'/>
  <title><data:blog.pageTitle/></title>
  <b:skin><![CDATA[ html,body{margin:0;padding:0;height:100%;} #wpspot-frame{border:0;width:100%;height:100vh;display:block;} ]]></b:skin>
</head>
<body>
  <b:section id='wpspot-root' showaddelement='no'>
    <b:widget id='WPSpotProxy1' type='HTML' version='2'>
      <b:widget-settings>
        <b:widget-setting name='content'>
          <![CDATA[
            <iframe id="wpspot-frame" src="${workerUrl}${"{{PATH}}"}" title="wpspot"></iframe>
            <script>
              (function(){
                var path = window.location.pathname + window.location.search + window.location.hash;
                var frame = document.getElementById('wpspot-frame');
                frame.src = "${workerUrl}" + path;
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
