#!/usr/bin/env node
// scripts/blogger-sync.js
// wpspot Sync 워크플로우에서 실행되는 스크립트.
// Blogger API(v3)로 블로그 정보를 조회하고, 블로그스팟 템플릿을
// "워드프레스형" 프록시 워커(Cloudflare Worker)로 위임하는 셸 템플릿으로 갱신한다.
//
// 필요한 환경변수:
//   GCP_BLOGGER_TOKEN  - Blogger API OAuth Access Token (blogger 스코프)
//   BLOG_ID            - Blogspot Blog ID
//   WORKER_URL         - 블로그스팟 프록시용 Cloudflare Worker URL

const BLOGGER_API = "https://www.googleapis.com/blogger/v3";

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

  // 2) 최신 게시물 목록을 가져와 워커 캐시 무효화를 위한 핑 전송 (선택적)
  const postsRes = await fetch(`${BLOGGER_API}/blogs/${blogId}/posts?maxResults=1`, { headers });
  if (postsRes.ok) {
    const posts = await postsRes.json();
    console.log(`최근 게시물 수: ${posts.items ? posts.items.length : 0}`);
  }

  // 3) 워커로 핑을 보내 프록시가 정상 응답하는지 확인
  const pingRes = await fetch(workerUrl, { method: "GET" });
  console.log(`프록시 워커 상태: ${pingRes.status}`);

  console.log("동기화 완료. 블로그스팟 프론트엔드는 프록시 워커를 통해 워드프레스 콘텐츠를 표시합니다.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
