// src/worker.js
// wpspot 메인 Cloudflare Worker.
// - 정적 파일(public/): Cloudflare Pages/Assets로 서빙
// - /api/*: D1 + KV 기반 REST API (회원가입/로그인 JWT, 계정 자격증명, 사이트 생성/프로비저닝)
//
// 외부 의존성 없이 Workers 표준 fetch + Web Crypto만 사용한다 (빠르고 에러 적음).

import { signJWT, hashPassword, verifyPassword, getUserFromRequest } from "./auth.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import * as gh from "./github.js";
import * as blogger from "./blogger.js";
import * as cf from "./cf.js";
import { generateUsername, generatePassword } from "./credentials.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function uid() {
  return crypto.randomUUID();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      // 정적 자산 서빙 (public/)
      return env.ASSETS.fetch(request);
    } catch (e) {
      return err(`서버 오류: ${e.message}`, 500);
    }
  },
};

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // ---------- 인증 ----------
  if (pathname === "/api/auth/signup" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { email, password, displayName } = body;
    if (!email || !password || password.length < 8) {
      return err("이메일과 8자 이상의 비밀번호를 입력해주세요.");
    }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return err("이미 가입된 이메일입니다.", 409);

    const id = uid();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)"
    ).bind(id, email, passwordHash, displayName || "").run();

    const token = await signJWT({ sub: id, email }, env.JWT_SECRET);
    return json({ token, user: { id, email, displayName: displayName || "" } });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { email, password } = body;
    if (!email || !password) return err("이메일과 비밀번호를 입력해주세요.");

    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (!user) return err("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return err("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

    const token = await signJWT({ sub: user.id, email: user.email }, env.JWT_SECRET);
    return json({ token, user: { id: user.id, email: user.email, displayName: user.display_name } });
  }

  // ---------- 이하 모든 API는 로그인 필요 ----------
  const authUser = await getUserFromRequest(request, env);
  if (!authUser) return err("로그인이 필요합니다.", 401);
  const userId = authUser.sub;

  // ---------- 계정: GCP/GitHub/Cloudflare 자격증명 ----------
  if (pathname === "/api/account/credentials" && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT cf_account_email, cf_account_id, github_token_enc, gcp_blogger_token_enc, cf_global_api_key_enc FROM user_credentials WHERE user_id = ?"
    ).bind(userId).first();

    return json({
      cfAccountEmail: row?.cf_account_email || "",
      cfAccountId: row?.cf_account_id || "",
      hasGithubToken: !!row?.github_token_enc,
      hasGcpBloggerToken: !!row?.gcp_blogger_token_enc,
      hasCfGlobalApiKey: !!row?.cf_global_api_key_enc,
    });
  }

  if (pathname === "/api/account/credentials" && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const { githubToken, gcpBloggerToken, cfGlobalApiKey, cfAccountEmail, cfAccountId } = body;

    const githubEnc = githubToken ? await encryptSecret(env, githubToken) : undefined;
    const gcpEnc = gcpBloggerToken ? await encryptSecret(env, gcpBloggerToken) : undefined;
    const cfKeyEnc = cfGlobalApiKey ? await encryptSecret(env, cfGlobalApiKey) : undefined;

    const existing = await env.DB.prepare("SELECT user_id FROM user_credentials WHERE user_id = ?").bind(userId).first();

    if (existing) {
      const sets = [];
      const binds = [];
      if (githubEnc !== undefined) { sets.push("github_token_enc = ?"); binds.push(githubEnc); }
      if (gcpEnc !== undefined) { sets.push("gcp_blogger_token_enc = ?"); binds.push(gcpEnc); }
      if (cfKeyEnc !== undefined) { sets.push("cf_global_api_key_enc = ?"); binds.push(cfKeyEnc); }
      if (cfAccountEmail !== undefined) { sets.push("cf_account_email = ?"); binds.push(cfAccountEmail); }
      if (cfAccountId !== undefined) { sets.push("cf_account_id = ?"); binds.push(cfAccountId); }
      sets.push("updated_at = strftime('%s','now')");
      if (sets.length) {
        await env.DB.prepare(`UPDATE user_credentials SET ${sets.join(", ")} WHERE user_id = ?`)
          .bind(...binds, userId).run();
      }
    } else {
      await env.DB.prepare(
        `INSERT INTO user_credentials
         (user_id, github_token_enc, gcp_blogger_token_enc, cf_global_api_key_enc, cf_account_email, cf_account_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(userId, githubEnc || null, gcpEnc || null, cfKeyEnc || null, cfAccountEmail || null, cfAccountId || null).run();
    }

    return json({ ok: true });
  }

  // ---------- 사이트 목록 ----------
  if (pathname === "/api/sites" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, site_name, blogger_blog_url, github_repo, cf_worker_url, status, wp_admin_path, created_at FROM sites WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(userId).all();
    return json({ sites: results });
  }

  // ---------- 사이트 생성 ----------
  if (pathname === "/api/sites" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { siteName, bloggerBlogId } = body;
    if (!siteName) return err("사이트 이름을 입력해주세요.");
    if (!/^[a-z0-9-]{3,40}$/.test(siteName)) {
      return err("사이트 이름은 영문 소문자, 숫자, 하이픈만 사용해 3~40자로 입력해주세요.");
    }

    const id = uid();
    await env.DB.prepare(
      `INSERT INTO sites (id, user_id, site_name, blogger_blog_id, status)
       VALUES (?, ?, ?, ?, 'pending')`
    ).bind(id, userId, siteName, bloggerBlogId || null).run();

    return json({ id, siteName, status: "pending" });
  }

  // ---------- 사이트 삭제 ----------
  const deleteMatch = pathname.match(/^\/api\/sites\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    const siteId = deleteMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    try {
      const cred = await env.DB.prepare("SELECT * FROM user_credentials WHERE user_id = ?").bind(userId).first();
      if (cred?.github_token_enc && site.github_repo) {
        const token = await decryptSecret(env, cred.github_token_enc);
        const [owner, repo] = site.github_repo.split("/");
        await gh.deleteRepo(token, owner, repo);
      }
    } catch (e) {
      // 레포 삭제 실패해도 DB 레코드는 정리한다
    }

    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(siteId).run();
    return json({ ok: true });
  }

  // ---------- 사이트 프로비저닝 ----------
  // GitHub에 레포 생성 + 워드프레스 원본/Actions 워크플로우 업로드 + provision 워크플로우 실행
  // + Cloudflare 프록시 워커 생성 + Blogspot 프록시 템플릿 적용
  const provisionMatch = pathname.match(/^\/api\/sites\/([^/]+)\/provision$/);
  if (provisionMatch && method === "POST") {
    const siteId = provisionMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    const cred = await env.DB.prepare("SELECT * FROM user_credentials WHERE user_id = ?").bind(userId).first();
    if (!cred?.github_token_enc) return err("내 계정에서 GitHub Token을 먼저 등록해주세요.", 400);
    if (!cred?.gcp_blogger_token_enc) return err("내 계정에서 GCP(Blogger API) Token을 먼저 등록해주세요.", 400);
    if (!cred?.cf_global_api_key_enc || !cred?.cf_account_email) {
      return err("내 계정에서 Cloudflare Global API Key와 계정 이메일을 먼저 등록해주세요.", 400);
    }
    if (!site.blogger_blog_id) return err("연동할 Blogspot Blog ID를 입력해주세요.", 400);

    const jobId = uid();
    await env.DB.prepare(
      "INSERT INTO site_jobs (id, site_id, job_type, status) VALUES (?, ?, 'provision', 'running')"
    ).bind(jobId, siteId).run();
    await env.DB.prepare("UPDATE sites SET status = 'provisioning', updated_at = strftime('%s','now') WHERE id = ?")
      .bind(siteId).run();

    try {
      const githubToken = await decryptSecret(env, cred.github_token_enc);
      const bloggerToken = await decryptSecret(env, cred.gcp_blogger_token_enc);
      const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);

      // 1) GitHub 레포 생성
      const ghUser = await gh.getAuthenticatedUser(githubToken);
      const repoName = `wpspot-${site.site_name}`;
      await gh.createRepo(githubToken, repoName);
      const repoFullName = `${ghUser.login}/${repoName}`;

      // 2) 워드프레스 원본 + Actions 워크플로우 업로드 (이 레포 .github/workflows/*.yml은
      //    이 프로젝트의 .github/workflows를 그대로 복제 배포한다)
      const provisionYml = await env.ASSETS.fetch(new URL("/_internal/workflows/provision.yml", request.url))
        .then(r => r.ok ? r.text() : null).catch(() => null);
      const syncYml = await env.ASSETS.fetch(new URL("/_internal/workflows/sync.yml", request.url))
        .then(r => r.ok ? r.text() : null).catch(() => null);

      if (provisionYml) {
        await gh.putFile(githubToken, ghUser.login, repoName, ".github/workflows/provision.yml", provisionYml, "chore: add provision workflow");
      }
      if (syncYml) {
        await gh.putFile(githubToken, ghUser.login, repoName, ".github/workflows/sync.yml", syncYml, "chore: add sync workflow");
      }

      // 3) provision 워크플로우 실행 (워드프레스 원본 + nginx/PHP-FPM 서버리스 환경 구성)
      if (provisionYml) {
        await gh.dispatchWorkflow(githubToken, ghUser.login, repoName, "provision.yml", "main", {
          site_name: site.site_name,
        });
      }

      // 4) Cloudflare 프록시 워커 배포 (사용자의 Cloudflare 계정에)
      let accountId = cred.cf_account_id;
      if (!accountId) accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
      const workerName = `wpspot-${site.site_name}`;
      // 워드프레스 오리진은 provision 워크플로우가 GitHub Pages/Actions로 배포할
      // 정적 엔드포인트를 가리킨다 (Pages 기본 도메인 규칙: <repo>.pages.dev)
      const wpOrigin = `https://${repoName}.pages.dev`;
      const workerUrl = await cf.deployProxyWorker(cred.cf_account_email, cfKey, accountId, workerName, wpOrigin);

      // 5) Blogspot 템플릿을 프록시 워커로 위임
      await blogger.setProxyTemplate(bloggerToken, site.blogger_blog_id, workerUrl);
      const blogInfo = await blogger.getBlog(bloggerToken, site.blogger_blog_id).catch(() => null);

      await env.DB.prepare(
        `UPDATE sites SET status = 'active', github_repo = ?, cf_worker_name = ?, cf_worker_url = ?, blogger_blog_url = ?, updated_at = strftime('%s','now') WHERE id = ?`
      ).bind(repoFullName, workerName, workerUrl, blogInfo?.url || null, siteId).run();

      if (!cred.cf_account_id) {
        await env.DB.prepare("UPDATE user_credentials SET cf_account_id = ? WHERE user_id = ?")
          .bind(accountId, userId).run();
      }

      // ---- 호스팅 접속 정보 생성 (phpMyAdmin-lite / SFTP 대체 / nginx 상태) ----
      const existingCred = await env.DB.prepare("SELECT site_id FROM site_credentials WHERE site_id = ?").bind(siteId).first();
      if (!existingCred) {
        const pmaUser = generateUsername();
        const pmaPass = generatePassword();
        const pmaPassHash = await hashPassword(pmaPass);
        const pmaPassEnc = await encryptSecret(env, pmaPass);

        await env.DB.prepare(
          `INSERT INTO site_credentials
           (site_id, phpmyadmin_username, phpmyadmin_password_hash, phpmyadmin_password_plain_enc,
            db_path, sftp_username, sftp_path_root, nginx_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')`
        ).bind(
          siteId, pmaUser, pmaPassHash, pmaPassEnc,
          "wordpress/wp-content/database/wordpress.db",
          ghUser.login, "/"
        ).run();
      } else {
        await env.DB.prepare("UPDATE site_credentials SET nginx_status = 'ready' WHERE site_id = ?").bind(siteId).run();
      }

      await env.DB.prepare(
        "UPDATE site_jobs SET status = 'success', message = ?, finished_at = strftime('%s','now') WHERE id = ?"
      ).bind("프로비저닝 완료", jobId).run();

      return json({ ok: true, workerUrl, githubRepo: repoFullName });
    } catch (e) {
      await env.DB.prepare("UPDATE sites SET status = 'error', updated_at = strftime('%s','now') WHERE id = ?")
        .bind(siteId).run();
      await env.DB.prepare(
        "UPDATE site_jobs SET status = 'failed', message = ?, finished_at = strftime('%s','now') WHERE id = ?"
      ).bind(String(e.message).slice(0, 500), jobId).run();
      return err(`프로비저닝 실패: ${e.message}`, 500);
    }
  }

  // ---------- 사이트 동기화 (워드프레스 → 깃허브/blogspot 재반영) ----------
  const syncMatch = pathname.match(/^\/api\/sites\/([^/]+)\/sync$/);
  if (syncMatch && method === "POST") {
    const siteId = syncMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    if (!site.github_repo) return err("아직 프로비저닝되지 않은 사이트입니다.", 400);

    const cred = await env.DB.prepare("SELECT * FROM user_credentials WHERE user_id = ?").bind(userId).first();
    if (!cred?.github_token_enc) return err("GitHub Token이 등록되어 있지 않습니다.", 400);

    const jobId = uid();
    await env.DB.prepare(
      "INSERT INTO site_jobs (id, site_id, job_type, status) VALUES (?, ?, 'sync', 'running')"
    ).bind(jobId, siteId).run();

    try {
      const githubToken = await decryptSecret(env, cred.github_token_enc);
      const [owner, repo] = site.github_repo.split("/");
      await gh.dispatchWorkflow(githubToken, owner, repo, "sync.yml", "main", {
        blogger_blog_id: site.blogger_blog_id || "",
      });
      await env.DB.prepare(
        "UPDATE site_jobs SET status = 'success', message = '동기화 실행됨', finished_at = strftime('%s','now') WHERE id = ?"
      ).bind(jobId).run();
      return json({ ok: true });
    } catch (e) {
      await env.DB.prepare(
        "UPDATE site_jobs SET status = 'failed', message = ?, finished_at = strftime('%s','now') WHERE id = ?"
      ).bind(String(e.message).slice(0, 500), jobId).run();
      return err(`동기화 실패: ${e.message}`, 500);
    }
  }

  // ---------- 호스팅 접속 정보 (phpMyAdmin-lite / SFTP 대체 / nginx 상태) ----------
  const credInfoMatch = pathname.match(/^\/api\/sites\/([^/]+)\/credentials$/);
  if (credInfoMatch && method === "GET") {
    const siteId = credInfoMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    const row = await env.DB.prepare("SELECT * FROM site_credentials WHERE site_id = ?").bind(siteId).first();
    if (!row) return json({ provisioned: false });

    const pmaPassword = row.phpmyadmin_password_plain_enc
      ? await decryptSecret(env, row.phpmyadmin_password_plain_enc)
      : null;

    return json({
      provisioned: true,
      phpmyadmin: {
        username: row.phpmyadmin_username,
        password: pmaPassword,
        url: `/phpmyadmin-lite.html?site=${siteId}`,
        dbPath: row.db_path,
      },
      sftp: {
        username: row.sftp_username,
        root: row.sftp_path_root,
        repo: site.github_repo,
        note: "실제 SFTP 포트 대신 GitHub API 기반 파일 관리자를 사용해요.",
        url: `/file-manager.html?site=${siteId}`,
      },
      nginx: {
        status: row.nginx_status,
        engine: "ephemeral GitHub Actions 컨테이너 (PHP 8.3 + nginx + OPcache)",
        workerUrl: site.cf_worker_url,
      },
    });
  }

  // ---------- 파일 관리자 (SFTP 대체: GitHub Contents API) ----------
  const filesMatch = pathname.match(/^\/api\/sites\/([^/]+)\/files$/);
  if (filesMatch) {
    const siteId = filesMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    if (!site.github_repo) return err("아직 프로비저닝되지 않은 사이트입니다.", 400);

    const cred = await env.DB.prepare("SELECT * FROM user_credentials WHERE user_id = ?").bind(userId).first();
    if (!cred?.github_token_enc) return err("GitHub Token이 등록되어 있지 않습니다.", 400);
    const githubToken = await decryptSecret(env, cred.github_token_enc);
    const [owner, repo] = site.github_repo.split("/");

    if (method === "GET") {
      const filePath = url.searchParams.get("path") || "";
      const data = await gh.getContents(githubToken, owner, repo, filePath);
      if (Array.isArray(data)) {
        return json({
          type: "dir",
          path: filePath,
          items: data.map((it) => ({ name: it.name, path: it.path, type: it.type, size: it.size })),
        });
      }
      return json({
        type: "file",
        path: data.path,
        size: data.size,
        encoding: data.encoding,
        content: data.content, // base64
      });
    }

    if (method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const { path: filePath, content, message } = body;
      if (!filePath || content === undefined) return err("path와 content가 필요합니다.");
      await gh.putFileBase64(githubToken, owner, repo, filePath, content, message || `chore: update ${filePath} via wpspot file manager`);
      return json({ ok: true });
    }

    if (method === "DELETE") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return err("path가 필요합니다.");
      await gh.deleteFile(githubToken, owner, repo, filePath, `chore: delete ${filePath} via wpspot file manager`);
      return json({ ok: true });
    }
  }

  // ---------- phpMyAdmin-lite: 워드프레스 SQLite DB 읽기/쓰기 ----------
  const dbMatch = pathname.match(/^\/api\/sites\/([^/]+)\/database$/);
  if (dbMatch) {
    const siteId = dbMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    if (!site.github_repo) return err("아직 프로비저닝되지 않은 사이트입니다.", 400);

    const siteCred = await env.DB.prepare("SELECT db_path FROM site_credentials WHERE site_id = ?").bind(siteId).first();
    const dbPath = siteCred?.db_path || "wordpress/wp-content/database/wordpress.db";

    const cred = await env.DB.prepare("SELECT * FROM user_credentials WHERE user_id = ?").bind(userId).first();
    if (!cred?.github_token_enc) return err("GitHub Token이 등록되어 있지 않습니다.", 400);
    const githubToken = await decryptSecret(env, cred.github_token_enc);
    const [owner, repo] = site.github_repo.split("/");

    if (method === "GET") {
      try {
        const data = await gh.getContents(githubToken, owner, repo, dbPath);
        return json({ path: dbPath, content: data.content, encoding: data.encoding, size: data.size });
      } catch (e) {
        return err(`데이터베이스 파일을 찾을 수 없습니다 (${dbPath}). 프로비저닝이 끝났는지 확인해주세요.`, 404);
      }
    }

    if (method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const { content } = body; // base64 SQLite 파일 전체
      if (!content) return err("content(base64)가 필요합니다.");
      await gh.putFileBase64(githubToken, owner, repo, dbPath, content, "chore: update wordpress.db via wpspot phpMyAdmin-lite");
      return json({ ok: true });
    }
  }

  return err("Not found", 404);
}

