// src/github.js
const GITHUB_API = "https://api.github.com";

function ghHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "wpspot-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function createRepo(token, repoName) {
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: false,
      description: "wpspot — WordPress hosting (nginx + PHP-FPM + SQLite)",
    }),
  });
  if (!res.ok && res.status !== 422) {
    const text = await res.text();
    throw new Error(`GitHub 레포 생성 실패: ${res.status} ${text}`);
  }
  return res.json().catch(() => ({}));
}

export async function getAuthenticatedUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub 사용자 정보 조회 실패: ${res.status}`);
  return res.json();
}

export async function createInitialCommit(token, owner, repo, files, message = "chore: initial commit") {
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;

  const blobs = await Promise.all(files.map(async ({ path, content }) => {
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
    return { path, sha: data.sha };
  }));

  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      tree: blobs.map(({ path, sha }) => ({ path, mode: "100644", type: "blob", sha })),
    }),
  });
  if (!treeRes.ok) {
    const text = await treeRes.text();
    throw new Error(`tree 생성 실패: ${treeRes.status} ${text}`);
  }
  const tree = await treeRes.json();

  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message, tree: tree.sha }),
  });
  if (!commitRes.ok) {
    const text = await commitRes.text();
    throw new Error(`커밋 생성 실패: ${commitRes.status} ${text}`);
  }
  const commit = await commitRes.json();

  const refRes = await fetch(`${base}/git/refs`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "refs/heads/main", sha: commit.sha }),
  });
  if (!refRes.ok && refRes.status !== 422) {
    const text = await refRes.text();
    throw new Error(`브랜치 생성 실패: ${refRes.status} ${text}`);
  }
  return commit;
}

export async function dispatchWorkflow(token, owner, repo, workflowFile, ref, inputs) {
  // 워크플로우가 활성화될 때까지 최대 30초 폴링
  const wfUrl = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const wfRes = await fetch(wfUrl, { headers: ghHeaders(token) });
    if (wfRes.ok) {
      const wf = await wfRes.json();
      if (wf.state === "active") break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

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

export async function getContents(token, owner, repo, path = "") {
  const encodedPath = path.split("/").map(p => encodeURIComponent(p)).join("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=main`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`경로 조회 실패 (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

export async function putFile(token, owner, repo, path, contentString, message) {
  const encodedPath = path.split("/").map(p => encodeURIComponent(p)).join("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;
  let sha;
  const getRes = await fetch(`${url}?ref=main`, { headers: ghHeaders(token) });
  if (getRes.ok) sha = (await getRes.json()).sha;
  const body = { message, content: toBase64(contentString), branch: "main" };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`파일 업로드 실패 (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

export async function putFileBase64(token, owner, repo, path, base64Content, message) {
  const encodedPath = path.split("/").map(p => encodeURIComponent(p)).join("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;
  let sha;
  const getRes = await fetch(`${url}?ref=main`, { headers: ghHeaders(token) });
  if (getRes.ok) sha = (await getRes.json()).sha;
  const body = { message, content: base64Content, branch: "main" };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`파일 업로드 실패 (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

export async function deleteFile(token, owner, repo, path, message) {
  const encodedPath = path.split("/").map(p => encodeURIComponent(p)).join("/");
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
    throw new Error(`파일 삭제 실패 (${path}): ${res.status} ${text}`);
  }
  return true;
}

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
