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
      auto_init: true,
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

  // 레포의 기본 브랜치(main 또는 master) HEAD SHA를 가져옴
  // auto_init:true 로 생성된 레포는 초기 커밋이 존재하므로 base_tree로 사용
  let parentSha = null;
  let baseTreeSha = null;
  let defaultBranch = "main";

  const repoInfoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (repoInfoRes.ok) {
    const repoInfo = await repoInfoRes.json();
    defaultBranch = repoInfo.default_branch || "main";
    const refRes = await fetch(`${base}/git/ref/heads/${defaultBranch}`, { headers: ghHeaders(token) });
    if (refRes.ok) {
      const refData = await refRes.json();
      parentSha = refData.object?.sha || null;
      if (parentSha) {
        const commitRes = await fetch(`${base}/git/commits/${parentSha}`, { headers: ghHeaders(token) });
        if (commitRes.ok) {
          const commitData = await commitRes.json();
          baseTreeSha = commitData.tree?.sha || null;
        }
      }
    }
  }

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

  const treeBody = {
    tree: blobs.map(({ path, sha }) => ({ path, mode: "100644", type: "blob", sha })),
  };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;

  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(treeBody),
  });
  if (!treeRes.ok) {
    const text = await treeRes.text();
    throw new Error(`tree 생성 실패: ${treeRes.status} ${text}`);
  }
  const tree = await treeRes.json();

  const commitBody = { message, tree: tree.sha };
  if (parentSha) commitBody.parents = [parentSha];

  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(commitBody),
  });
  if (!commitRes.ok) {
    const text = await commitRes.text();
    throw new Error(`커밋 생성 실패: ${commitRes.status} ${text}`);
  }
  const commit = await commitRes.json();

  // 이미 브랜치가 존재하면 PATCH로 업데이트, 없으면 POST로 생성
  const refUrl = `${base}/git/refs/heads/${defaultBranch}`;
  const patchRes = await fetch(refUrl, {
    method: "PATCH",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  if (!patchRes.ok) {
    // PATCH 실패 시 새 ref 생성 시도
    const postRes = await fetch(`${base}/git/refs`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${defaultBranch}`, sha: commit.sha }),
    });
    if (!postRes.ok && postRes.status !== 422) {
      const text = await postRes.text();
      throw new Error(`브랜치 생성 실패: ${postRes.status} ${text}`);
    }
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
