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

// 레포 생성 후 초기 커밋(auto_init README)이 실제로 존재할 때까지 폴링
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
  const repoData = await res.json().catch(() => ({}));
  const owner = repoData.owner?.login;
  const repo  = repoData.name || repoName;

  // auto_init 커밋이 실제로 생성될 때까지 최대 30초 폴링
  if (owner) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const r = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits`, {
        headers: ghHeaders(token),
      });
      if (r.ok) {
        const commits = await r.json().catch(() => []);
        if (Array.isArray(commits) && commits.length > 0) break; // 초기 커밋 확인
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return repoData;
}

export async function getAuthenticatedUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub 사용자 정보 조회 실패: ${res.status}`);
  return res.json();
}

// default_branch 확인 헬퍼 — 브랜치에 실제 커밋이 있을 때만 반환
export async function getDefaultBranch(token, owner, repo) {
  const deadline = Date.now() + 30000;
  let defaultBranch = "main";
  while (Date.now() < deadline) {
    const r = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
    if (r.ok) {
      const info = await r.json();
      if (info.default_branch) defaultBranch = info.default_branch;
      // 브랜치 ref가 실제로 존재하는지(= 커밋이 있는지) 확인
      const refRes = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`,
        { headers: ghHeaders(token) }
      );
      if (refRes.ok) return defaultBranch; // ref 존재 = 커밋 있음
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return defaultBranch;
}

// blob/tree API 대신 contents API로 파일 순차 업로드 — default_branch 반환
export async function createInitialCommit(token, owner, repo, files, message = "chore: initial commit") {
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(token, owner, repo);

  for (const { path, content } of files) {
    const encodedPath = path.split("/").map(p => encodeURIComponent(p)).join("/");
    const url = `${base}/contents/${encodedPath}`;

    let sha;
    const getRes = await fetch(`${url}?ref=${defaultBranch}`, { headers: ghHeaders(token) });
    if (getRes.ok) sha = (await getRes.json()).sha;

    const body = {
      message: `${message} — ${path}`,
      content: toBase64(content),
      branch: defaultBranch,
    };
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
  }

  const refRes = await fetch(`${base}/git/ref/heads/${defaultBranch}`, { headers: ghHeaders(token) });
  const refData = refRes.ok ? await refRes.json() : {};
  return { sha: refData.object?.sha, defaultBranch };
}

export async function dispatchWorkflow(token, owner, repo, workflowFile, ref, inputs) {
  const wfUrl = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}`;

  // 워크플로우가 active 상태가 될 때까지 최대 90초 폴링
  const deadline = Date.now() + 90000;
  let isActive = false;
  while (Date.now() < deadline) {
    const wfRes = await fetch(wfUrl, { headers: ghHeaders(token) });
    if (wfRes.ok) {
      const wf = await wfRes.json();
      if (wf.state === "active") { isActive = true; break; }
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  if (!isActive) {
    throw new Error(`워크플로우 활성화 대기 시간 초과 (${workflowFile})`);
  }

  // active 직후 바로 dispatch하면 422가 올 수 있으므로 5초 추가 대기
  await new Promise(r => setTimeout(r, 5000));

  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

  // 422 발생 시 10초 간격 최대 5회 재시도
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: ref, inputs: inputs || {} }),
    });
    if (res.ok) return true;
    const text = await res.text();
    if (res.status === 422 && attempt < 5) {
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }
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
