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

// UTF-8 문자열 → base64 (멀티바이트 안전)
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 사용자 계정에 새 레포 생성
// auto_init: true — README로 첫 커밋을 만들어 Git 저장소를 즉시 초기화함.
// blob/tree API는 커밋이 하나라도 있어야 동작하므로 반드시 true여야 한다.
export async function createRepo(token, repoName) {
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: true,   // Git 저장소를 즉시 초기화 (blob API 사용 가능 상태로)
      description: "wpspot - WordPress-style Blogspot hosting (headless WordPress backend)",
    }),
  });
  if (!res.ok && res.status !== 422) {
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

// Git Tree API를 이용해 여러 파일을 한 번의 커밋으로 올림
// files: [{ path, content }]  (content는 UTF-8 문자열)
// auto_init:true 로 생성된 레포(README 초기 커밋 존재)에서 동작함.
// 기존 README 등 auto_init 파일은 새 트리에 포함되지 않으므로 자동으로 제거됨.
export async function createInitialCommit(token, owner, repo, files, message = "chore: initial commit") {
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;

  // 1) main 브랜치의 현재 HEAD SHA 조회 (auto_init이 만든 첫 커밋)
  const refRes = await fetch(`${base}/git/ref/heads/main`, { headers: ghHeaders(token) });
  if (!refRes.ok) {
    const text = await refRes.text();
    throw new Error(`HEAD ref 조회 실패: ${refRes.status} ${text}`);
  }
  const refData = await refRes.json();
  const parentSha = refData.object.sha;

  // 2) 각 파일을 blob으로 생성 (순차 처리 — 병렬 시 일부 서버에서 경합 발생 가능)
  const blobs = [];
  for (const { path, content } of files) {
    const res = await fetch(`${base}/git/blobs`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content: toBase64(content), encoding: "base64" }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`blob 생성 실패 (${path}): ${res.status} ${text}`);
    }
    const data = await res.json();
    blobs.push({ path, sha: data.sha });
  }

  // 3) tree 생성 (base_tree 없음 = README 등 auto_init 파일을 포함하지 않는 완전 새 트리)
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      tree: blobs.map(({ path, sha }) => ({
        path,
        mode: "100644",
        type: "blob",
        sha,
      })),
    }),
  });
  if (!treeRes.ok) {
    const text = await treeRes.text();
    throw new Error(`tree 생성 실패: ${treeRes.status} ${text}`);
  }
  const tree = await treeRes.json();

  // 4) 커밋 생성 (parent = auto_init 첫 커밋)
  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  if (!commitRes.ok) {
    const text = await commitRes.text();
    throw new Error(`커밋 생성 실패: ${commitRes.status} ${text}`);
  }
  const commit = await commitRes.json();

  // 5) main 브랜치를 새 커밋으로 force-update
  const updateRefRes = await fetch(`${base}/git/refs/heads/main`, {
    method: "PATCH",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
  if (!updateRefRes.ok) {
    const text = await updateRefRes.text();
    throw new Error(`브랜치 업데이트 실패: ${updateRefRes.status} ${text}`);
  }

  return commit;
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

  const content = toBase64(contentString);
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

// GitHub Actions가 workflow_dispatch 트리거를 인식할 때까지 polling 대기
// createInitialCommit으로 워크플로우를 포함해 올렸어도 GitHub 내부 인덱싱에
// 수 초가 걸릴 수 있으므로 active 상태가 될 때까지 폴링한다.
export async function waitForWorkflowReady(token, owner, repo, workflowFile, maxWaitMs = 30000) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}`;
  const interval = 2000; // 2초마다 폴링
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const res = await fetch(url, { headers: ghHeaders(token) });
      if (res.ok) {
        const data = await res.json();
        if (data.state === "active") return true;
      }
    } catch (_) {
      // 네트워크 오류는 무시하고 재시도
    }
  }

  throw new Error(
    `워크플로우(${workflowFile})가 ${maxWaitMs / 1000}초 내에 활성화되지 않았습니다. ` +
    "GitHub 레포 Actions 탭에서 직접 provision 워크플로우를 실행해주세요."
  );
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
  return res.json();
}

export function getRequiredSecrets(cfWorkerUrl, cfAccountId, cfApiToken, bloggerToken) {
  return {
    CF_WORKER_URL: cfWorkerUrl,
    CF_ACCOUNT_ID: cfAccountId,
    CF_API_TOKEN: cfApiToken,
    GCP_BLOGGER_TOKEN: bloggerToken,
  };
}
