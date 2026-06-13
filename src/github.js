// src/github.js
// 사용자가 입력한 GitHub Personal Access Token으로
// 1) 레포 생성, 2) 워드프레스 원본 파일/폴더 + GitHub Actions 워크플로우 커밋,
// 3) provisioning/sync 워크플로우 dispatch 를 수행한다.

const GITHUB_API = "https://api.github.com";

function ghHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "wpspot-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// 사용자 계정에 새 레포 생성 (wpspot-사이트이름)
export async function createRepo(token, repoName) {
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: true,
      description: "wpspot - WordPress-style Blogspot hosting (headless WordPress backend)",
    }),
  });
  if (!res.ok && res.status !== 422) {
    // 422 = 이미 같은 이름의 레포 존재 (재시도 시 무시)
    const text = await res.text();
    throw new Error(`GitHub 레포 생성 실패: ${res.status} ${text}`);
  }
  return res.json().catch(() => ({}));
}

// 로그인한 사용자 정보 (owner login 확인용)
export async function getAuthenticatedUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub 사용자 정보 조회 실패: ${res.status}`);
  return res.json();
}

// 레포에 파일 생성/업데이트 (Contents API, base64 인코딩)
export async function putFile(token, owner, repo, path, contentString, message) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;

  // 기존 파일이 있으면 sha를 조회해야 업데이트 가능
  let sha;
  const getRes = await fetch(`${url}?ref=main`, { headers: ghHeaders(token) });
  if (getRes.ok) {
    const data = await getRes.json();
    sha = data.sha;
  }

  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(contentString))),
    branch: "main",
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 파일 업로드 실패 (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

// GitHub Actions 워크플로우 dispatch (provision.yml / sync.yml 등)
export async function dispatchWorkflow(token, owner, repo, workflowFile, ref, inputs) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: ref || "main", inputs: inputs || {} }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`워크플로우 실행 실패 (${workflowFile}): ${res.status} ${text}`);
  }
  return true;
}

// 디렉토리 목록 또는 파일 메타데이터 조회 (SFTP 대체 파일 관리자용)
export async function getContents(token, owner, repo, path = "") {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=main`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`경로 조회 실패 (${path}): ${res.status} ${text}`);
  }
  return res.json(); // 배열(디렉토리) 또는 객체(파일, content=base64)
}

// base64 컨텐츠를 그대로 업로드 (이미지/SQLite 등 바이너리 파일용)
export async function putFileBase64(token, owner, repo, path, base64Content, message) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;

  let sha;
  const getRes = await fetch(`${url}?ref=main`, { headers: ghHeaders(token) });
  if (getRes.ok) {
    const data = await getRes.json();
    sha = data.sha;
  }

  const body = { message, content: base64Content, branch: "main" };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 파일 업로드 실패 (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

// 파일 삭제
export async function deleteFile(token, owner, repo, path, message) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  const getRes = await fetch(`${url}?ref=main`, { headers: ghHeaders(token) });
  if (!getRes.ok) throw new Error(`삭제할 파일을 찾을 수 없습니다: ${path}`);
  const { sha } = await getRes.json();

  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: "main" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 파일 삭제 실패 (${path}): ${res.status} ${text}`);
  }
  return true;
}

// 레포 삭제 (사이트 삭제 시)
export async function deleteRepo(token, owner, repo) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    method: "DELETE",
    headers: ghHeaders(token),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub 레포 삭제 실패: ${res.status}`);
  }
  return true;
}
