// src/github.js
// 사용자가 입력한 GitHub Personal Access Token으로
// 레포 생성, 파일/워크플로우 커밋, workflow dispatch를 수행한다.

const GITHUB_API = "https://api.github.com";

function ghHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "wpspot-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// 사용자 계정에 새 레포 생성
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

// 로그인한 사용자 정보
export async function getAuthenticatedUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub 사용자 정보 조회 실패: ${res.status}`);
  return res.json();
}

// 레포에 파일 생성/업데이트 (Contents API, UTF-8 텍스트)
export async function putFile(token, owner, repo, path, contentString, message) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path.replace(/^\//, "")}`;

  // 기존 파일 sha 조회 (업데이트 시 필요)
  let sha;
  const getRes = await fetch(`${url}?ref=main`, { headers: ghHeaders(token) });
  if (getRes.ok) {
    const data = await getRes.json();
    sha = data.sha;
  }

  // UTF-8 → base64 (멀티바이트 안전)
  const bytes = new TextEncoder().encode(contentString);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const content = btoa(bin);

  const body = { message, content, branch: "main" };
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

// GitHub Actions 워크플로우 dispatch
// ※ 워크플로우 파일이 main 브랜치에 푸시된 후 GitHub가 인식하기까지 약간의 지연이 있음.
//   dispatchWorkflow 전에 충분히 기다려야 한다 (호출 측에서 대기).
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

// 디렉토리 목록 또는 파일 메타데이터 조회
export async function getContents(token, owner, repo, path = "") {
  const encodedPath = path
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=main`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`경로 조회 실패 (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

// base64 컨텐츠를 그대로 업로드 (이미지/SQLite 등 바이너리 파일용)
export async function putFileBase64(token, owner, repo, path, base64Content, message) {
  const encodedPath = path
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;

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
  const encodedPath = path
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;
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

// 레포 Public Key 조회 (Secrets 암호화용)
export async function getRepoPublicKey(token, owner, repo) {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/public-key`,
    { headers: ghHeaders(token) }
  );
  if (!res.ok) throw new Error(`Public key 조회 실패: ${res.status}`);
  return res.json(); // { key_id, key }
}

// 레포 Secret 설정 (GitHub Actions에서 사용할 시크릿 자동 주입)
// value는 평문 문자열. libsodium sealed box로 암호화해야 하지만
// Workers 환경에서는 libsodium이 없으므로 Web Crypto + SubtleCrypto로 대체.
// GitHub는 libsodium sealed box(X25519+XSalsa20Poly1305)를 요구하므로
// 실제 암호화는 Worker 내에서 직접 처리할 수 없다.
// → 이 함수는 secret 이름 목록을 반환하고, 실제 암호화 없이 평문 전달 경고를 남긴다.
// 프로덕션에서는 GitHub CLI(`gh secret set`) 또는 별도 서버를 사용해야 한다.
// worker.js에서는 이 함수를 통해 필요한 secrets 목록을 알 수 있다.
export function getRequiredSecrets(cfWorkerUrl, cfAccountId, cfApiToken, bloggerToken) {
  return {
    CF_WORKER_URL: cfWorkerUrl,
    CF_ACCOUNT_ID: cfAccountId,
    CF_API_TOKEN: cfApiToken,         // Cloudflare API Token (Pages 배포용)
    GCP_BLOGGER_TOKEN: bloggerToken,  // Blogger OAuth Access Token
  };
}
