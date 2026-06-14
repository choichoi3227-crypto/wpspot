// src/worker.js
// wpspot 메인 Cloudflare Worker

import { signJWT, verifyJWT, hashPassword, verifyPassword, getUserFromRequest } from "./auth.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import * as gh from "./github.js";
import * as blogger from "./blogger.js";
import * as cf from "./cf.js";
import { generateUsername, generatePassword } from "./credentials.js";
import { slugify, initWpSchema } from "./utils.js";

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

// KST 기준 다음날 자정 unix timestamp
function kstMidnightTimestamp() {
  const now = new Date();
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCHours(15, 0, 0, 0); // UTC 15:00 = KST 다음날 00:00
  if (kst.getTime() <= now.getTime()) {
    kst.setUTCDate(kst.getUTCDate() + 1);
  }
  return Math.floor(kst.getTime() / 1000);
}

// 32자 hex 난수 생성
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error("Worker error:", e.message, e.stack);
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

  // ---------- phpMyAdmin 토큰 검증 (phpmyadmin 접속용 — 로그인 불필요 공개 엔드포인트) ----------
  const pmaAuthMatch = pathname.match(/^\/api\/pma\/([^/]+)\/auth$/);
  if (pmaAuthMatch && method === "POST") {
    const token = pmaAuthMatch[1];
    const body = await request.json().catch(() => ({}));
    const { username, password } = body;

    const now = Math.floor(Date.now() / 1000);
    const tokenRow = await env.DB.prepare(
      "SELECT * FROM phpmyadmin_tokens WHERE token = ? AND expires_at > ?"
    ).bind(token, now).first();
    if (!tokenRow) return err("접속 링크가 만료되었거나 유효하지 않아요. 새 링크를 발급해주세요.", 401);

    const siteCred = await env.DB.prepare(
      "SELECT * FROM site_credentials WHERE site_id = ?"
    ).bind(tokenRow.site_id).first();
    if (!siteCred) return err("사이트 자격증명을 찾을 수 없어요.", 404);

    if (siteCred.phpmyadmin_username !== username) return err("아이디 또는 비밀번호가 올바르지 않아요.", 401);
    const valid = await verifyPassword(password, siteCred.phpmyadmin_password_hash);
    if (!valid) return err("아이디 또는 비밀번호가 올바르지 않아요.", 401);

    const pmaSessionToken = await signJWT(
      { sub: tokenRow.site_id, pma: true },
      env.JWT_SECRET,
      3600
    );
    return json({ ok: true, sessionToken: pmaSessionToken, siteId: tokenRow.site_id });
  }

  // ---------- 이하 모든 API는 로그인 필요 ----------
  const authUser = await getUserFromRequest(request, env);
  if (!authUser) return err("로그인이 필요합니다.", 401);
  const userId = authUser.sub;

  // ---------- 계정 자격증명 ----------
  if (pathname === "/api/account/credentials" && method === "GET") {
    const row = await env.DB.prepare(
      `SELECT cf_account_email, cf_account_id, github_token_enc,
              gcp_blogger_token_enc, cf_global_api_key_enc, cf_api_token_enc,
              gcp_blogger_client_id, gcp_blogger_client_secret_enc,
              gcp_blogger_refresh_token_enc, gcp_blogger_token_expires_at
       FROM user_credentials WHERE user_id = ?`
    ).bind(userId).first();

    const now = Math.floor(Date.now() / 1000);
    const tokenExpired = row?.gcp_blogger_token_expires_at
      ? now >= row.gcp_blogger_token_expires_at
      : true;

    return json({
      cfAccountEmail: row?.cf_account_email || "",
      cfAccountId: row?.cf_account_id || "",
      hasGithubToken: !!row?.github_token_enc,
      hasGcpBloggerToken: !!row?.gcp_blogger_token_enc,
      hasCfGlobalApiKey: !!row?.cf_global_api_key_enc,
      hasCfApiToken: !!row?.cf_api_token_enc,
      // OAuth 자동 갱신 관련
      gcpClientId: row?.gcp_blogger_client_id || "",
      hasGcpClientSecret: !!row?.gcp_blogger_client_secret_enc,
      hasGcpRefreshToken: !!row?.gcp_blogger_refresh_token_enc,
      gcpTokenExpired: tokenExpired,
      gcpTokenExpiresAt: row?.gcp_blogger_token_expires_at || null,
    });
  }

  if (pathname === "/api/account/credentials" && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const {
      githubToken, gcpBloggerToken, cfGlobalApiKey, cfAccountEmail, cfAccountId,
      cfApiToken,
      gcpClientId, gcpClientSecret, gcpRefreshToken,
    } = body;

    const githubEnc = githubToken ? await encryptSecret(env, githubToken) : undefined;
    const gcpEnc = gcpBloggerToken ? await encryptSecret(env, gcpBloggerToken) : undefined;
    const cfKeyEnc = cfGlobalApiKey ? await encryptSecret(env, cfGlobalApiKey) : undefined;
    const cfApiTokenEnc = cfApiToken ? await encryptSecret(env, cfApiToken) : undefined;
    const gcpSecretEnc = gcpClientSecret ? await encryptSecret(env, gcpClientSecret) : undefined;
    const gcpRefreshEnc = gcpRefreshToken ? await encryptSecret(env, gcpRefreshToken) : undefined;

    const existing = await env.DB.prepare("SELECT user_id FROM user_credentials WHERE user_id = ?").bind(userId).first();

    if (existing) {
      const sets = [];
      const binds = [];
      if (githubEnc !== undefined)      { sets.push("github_token_enc = ?");                   binds.push(githubEnc); }
      if (gcpEnc !== undefined)         { sets.push("gcp_blogger_token_enc = ?");               binds.push(gcpEnc); }
      if (cfKeyEnc !== undefined)       { sets.push("cf_global_api_key_enc = ?");               binds.push(cfKeyEnc); }
      if (cfApiTokenEnc !== undefined)  { sets.push("cf_api_token_enc = ?");                    binds.push(cfApiTokenEnc); }
      if (cfAccountEmail !== undefined) { sets.push("cf_account_email = ?");                    binds.push(cfAccountEmail); }
      if (cfAccountId !== undefined)    { sets.push("cf_account_id = ?");                       binds.push(cfAccountId); }
      if (gcpClientId !== undefined)    { sets.push("gcp_blogger_client_id = ?");               binds.push(gcpClientId); }
      if (gcpSecretEnc !== undefined)   { sets.push("gcp_blogger_client_secret_enc = ?");       binds.push(gcpSecretEnc); }
      if (gcpRefreshEnc !== undefined)  { sets.push("gcp_blogger_refresh_token_enc = ?");       binds.push(gcpRefreshEnc);
                                          sets.push("gcp_blogger_token_expires_at = 0"); }
      sets.push("updated_at = strftime('%s','now')");
      await env.DB.prepare(`UPDATE user_credentials SET ${sets.join(", ")} WHERE user_id = ?`)
        .bind(...binds, userId).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO user_credentials
         (user_id, github_token_enc, gcp_blogger_token_enc, cf_global_api_key_enc, cf_api_token_enc,
          cf_account_email, cf_account_id,
          gcp_blogger_client_id, gcp_blogger_client_secret_enc, gcp_blogger_refresh_token_enc,
          gcp_blogger_token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).bind(
        userId,
        githubEnc || null, gcpEnc || null, cfKeyEnc || null, cfApiTokenEnc || null,
        cfAccountEmail || null, cfAccountId || null,
        gcpClientId || null, gcpSecretEnc || null, gcpRefreshEnc || null,
      ).run();
    }

    return json({ ok: true });
  }

  // ---------- Google OAuth 콜백 (Authorization Code → Tokens) ----------
  if (pathname === "/api/auth/google/callback" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { code, redirectUri, clientId, clientSecret } = body;
    if (!code || !redirectUri || !clientId || !clientSecret) {
      return err("code, redirectUri, clientId, clientSecret가 모두 필요합니다.");
    }
    const tokens = await blogger.exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);

    // 토큰 암호화 후 DB 저장
    const accessEnc = await encryptSecret(env, tokens.accessToken);
    const refreshEnc = tokens.refreshToken ? await encryptSecret(env, tokens.refreshToken) : null;
    const secretEnc = await encryptSecret(env, clientSecret);

    const existing = await env.DB.prepare("SELECT user_id FROM user_credentials WHERE user_id = ?").bind(userId).first();
    if (existing) {
      const sets = [
        "gcp_blogger_client_id = ?",
        "gcp_blogger_client_secret_enc = ?",
        "gcp_blogger_token_enc = ?",
        "gcp_blogger_token_expires_at = ?",
        "updated_at = strftime('%s','now')",
      ];
      const binds = [clientId, secretEnc, accessEnc, tokens.expiresAt];
      if (refreshEnc) {
        sets.splice(3, 0, "gcp_blogger_refresh_token_enc = ?");
        binds.splice(3, 0, refreshEnc);
      }
      await env.DB.prepare(`UPDATE user_credentials SET ${sets.join(", ")} WHERE user_id = ?`)
        .bind(...binds, userId).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO user_credentials
         (user_id, gcp_blogger_client_id, gcp_blogger_client_secret_enc,
          gcp_blogger_token_enc, gcp_blogger_refresh_token_enc, gcp_blogger_token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(userId, clientId, secretEnc, accessEnc, refreshEnc, tokens.expiresAt).run();
    }

    return json({ ok: true, hasRefreshToken: !!tokens.refreshToken });
  }

  // ---------- Google OAuth URL 생성 ----------
  if (pathname === "/api/auth/google/url" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { clientId, redirectUri } = body;
    if (!clientId || !redirectUri) return err("clientId와 redirectUri가 필요합니다.");

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/blogger",
      access_type: "offline",   // refresh_token 발급
      prompt: "consent",        // 항상 refresh_token 반환 보장
    });
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ---------- 사이트 목록 ----------
  if (pathname === "/api/sites" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, site_name, site_slug, blogger_blog_url, github_repo, cf_worker_url, status, wp_admin_path, created_at FROM sites WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(userId).all();
    return json({ sites: results });
  }

  // ---------- 사이트 생성 ----------
  if (pathname === "/api/sites" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { siteName, bloggerBlogId } = body;
    if (!siteName || siteName.trim().length < 1) return err("사이트 이름을 입력해주세요.");
    if (siteName.trim().length > 60) return err("사이트 이름은 60자 이하로 입력해주세요.");

    // 한글/영어/숫자/공백/하이픈 허용. URL slug는 자동 변환
    const siteSlug = slugify(siteName.trim());
    if (siteSlug.length < 3) {
      return err("사이트 이름이 너무 짧아요. 더 길게 입력해주세요.");
    }

    // slug 중복 방지 (같은 사용자)
    const existing = await env.DB.prepare(
      "SELECT id FROM sites WHERE user_id = ? AND site_slug = ?"
    ).bind(userId, siteSlug).first();
    if (existing) return err("같은 이름의 사이트가 이미 있어요.");

    const id = uid();
    await env.DB.prepare(
      `INSERT INTO sites (id, user_id, site_name, site_slug, blogger_blog_id, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).bind(id, userId, siteName.trim(), siteSlug, bloggerBlogId || null).run();

    return json({ id, siteName: siteName.trim(), siteSlug, status: "pending" });
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
      // 레포 삭제 실패해도 DB는 정리
    }

    // WP 스키마 데이터 정리
    const wpTables = [
      "wp_commentmeta", "wp_comments", "wp_term_relationships",
      "wp_term_taxonomy", "wp_terms", "wp_postmeta", "wp_posts",
      "wp_usermeta", "wp_users", "wp_options", "wp_links",
    ];
    for (const t of wpTables) {
      await env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(siteId).run().catch(() => {});
    }
    await env.DB.prepare("DELETE FROM phpmyadmin_tokens WHERE site_id = ?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_credentials WHERE site_id = ?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_jobs WHERE site_id = ?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(siteId).run();
    return json({ ok: true });
  }

  // ---------- 사이트 프로비저닝 ----------
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
      const bloggerToken = await blogger.getValidAccessToken(cred, env, env.DB, userId);
      const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);

      // 1) GitHub 레포 생성
      const ghUser = await gh.getAuthenticatedUser(githubToken);
      const repoName = `wpspot-${site.site_slug}`;
      await gh.createRepo(githubToken, repoName);
      const repoFullName = `${ghUser.login}/${repoName}`;

      // 2) Cloudflare 계정 ID 확보 + 프록시 워커 배포
      // (provision 워크플로우 dispatch 전에 먼저 확보해야 secret inputs에 포함 가능)
      let accountId = cred.cf_account_id;
      if (!accountId) accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
      const workerName = `wpspot-${site.site_slug}`;
      const wpOrigin = `https://${repoName}.pages.dev`;
      const workerUrl = await cf.deployProxyWorker(cred.cf_account_email, cfKey, accountId, workerName, wpOrigin);

      if (!cred.cf_account_id) {
        await env.DB.prepare("UPDATE user_credentials SET cf_account_id = ? WHERE user_id = ?")
          .bind(accountId, userId).run();
      }

      // 3) Blogspot 템플릿 적용
      const templateResult = await blogger.setProxyTemplate(bloggerToken, site.blogger_blog_id, workerUrl);
      const blogInfo = await blogger.getBlog(bloggerToken, site.blogger_blog_id).catch(() => null);

      await env.DB.prepare(
        `UPDATE sites SET status = 'active', github_repo = ?, cf_worker_name = ?, cf_worker_url = ?, blogger_blog_url = ?, updated_at = strftime('%s','now') WHERE id = ?`
      ).bind(repoFullName, workerName, workerUrl, blogInfo?.url || null, siteId).run();

      // 4) 워크플로우 파일 로드 및 업로드
      const [provisionYml, syncYml] = await Promise.all([
        env.ASSETS.fetch(new Request("https://wpspot.app/_internal/workflows/provision.yml"))
          .then(r => { if (!r.ok) throw new Error(`provision.yml 로드 실패: ${r.status}`); return r.text(); }),
        env.ASSETS.fetch(new Request("https://wpspot.app/_internal/workflows/sync.yml"))
          .then(r => { if (!r.ok) throw new Error(`sync.yml 로드 실패: ${r.status}`); return r.text(); }),
      ]);

      await gh.putFile(githubToken, ghUser.login, repoName, ".github/workflows/provision.yml", provisionYml, "chore: add provision workflow");
      await gh.putFile(githubToken, ghUser.login, repoName, ".github/workflows/sync.yml", syncYml, "chore: add sync workflow");

      // 5) provision 워크플로우 실행 (Secret 값을 inputs로 전달 → 러너가 gh secret set으로 등록)
      // GitHub가 방금 푸시된 워크플로우 파일을 인식하기까지 약 3초 대기 (race condition 방지)
      await new Promise(r => setTimeout(r, 3000));

      // CF_API_TOKEN은 wrangler.toml 기반 배포에 필요. 계정에 저장된 값 사용.
      // 없으면 빈 문자열 전달 (나중에 수동 등록 안내)
      const cfApiTokenPlain = cred.cf_api_token_enc
        ? await decryptSecret(env, cred.cf_api_token_enc).catch(() => "")
        : "";

      await gh.dispatchWorkflow(githubToken, ghUser.login, repoName, "provision.yml", "main", {
        site_name: site.site_slug,
        site_display_name: site.site_name,
        // Secret 자동 등록용 inputs (HTTPS 전송, 러너에서 즉시 ::add-mask:: 처리)
        secret_cf_worker_url: workerUrl,
        secret_cf_account_id: accountId,
        secret_cf_api_token: cfApiTokenPlain,
        secret_gcp_blogger_token: bloggerToken,
        secret_blog_id: site.blogger_blog_id || "",
        secret_github_token: githubToken,  // PAT — secrets 등록에 필요
      });

      // 6) 호스팅 접속 정보 생성
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

      // 7) WordPress 기본 스키마 초기화
      await initWpSchema(env.DB, siteId, site.site_name, workerUrl, blogInfo?.url || null);

      await env.DB.prepare(
        "UPDATE site_jobs SET status = 'success', message = ?, finished_at = strftime('%s','now') WHERE id = ?"
      ).bind("프로비저닝 완료", jobId).run();

      return json({
        ok: true,
        workerUrl,
        githubRepo: repoFullName,
        bloggerTemplateApplied: templateResult.templateApplied,
        bloggerTemplateNote: templateResult.note,
        bloggerTemplateXml: templateResult.templateApplied ? undefined : templateResult.xml,
        secretsAutoRegistered: true,
        nextStep: cfApiTokenPlain
          ? "GitHub Actions Secrets가 자동 등록됐습니다. provision 워크플로우가 완료되면 사이트가 활성화됩니다."
          : "CF_API_TOKEN(Cloudflare API Token)은 자동 등록되지 않았습니다. GitHub 레포 Settings → Secrets → Actions에서 CF_API_TOKEN을 수동으로 등록해주세요.",
      });
    } catch (e) {
      console.error("Provision error:", e.message, e.stack);
      await env.DB.prepare("UPDATE sites SET status = 'error', updated_at = strftime('%s','now') WHERE id = ?")
        .bind(siteId).run();
      await env.DB.prepare(
        "UPDATE site_jobs SET status = 'failed', message = ?, finished_at = strftime('%s','now') WHERE id = ?"
      ).bind(String(e.message).slice(0, 500), jobId).run();
      return err(`프로비저닝 실패: ${e.message}`, 500);
    }
  }

  // ---------- 사이트 동기화 ----------
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

  // ---------- phpMyAdmin 토큰 발급/조회 ----------
  // GET: 유효한 토큰 반환 (없으면 새로 발급)
  const pmaTokenMatch = pathname.match(/^\/api\/sites\/([^/]+)\/pma-token$/);
  if (pmaTokenMatch && method === "GET") {
    const siteId = pmaTokenMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    const now = Math.floor(Date.now() / 1000);
    // 만료된 토큰 정리
    await env.DB.prepare("DELETE FROM phpmyadmin_tokens WHERE expires_at < ?").bind(now).run().catch(() => {});

    let tokenRow = await env.DB.prepare(
      "SELECT * FROM phpmyadmin_tokens WHERE site_id = ? AND expires_at > ?"
    ).bind(siteId, now).first();

    if (!tokenRow) {
      const newToken = randomToken();
      const expiresAt = kstMidnightTimestamp();
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO phpmyadmin_tokens (id, site_id, token, expires_at) VALUES (?, ?, ?, ?)"
      ).bind(id, siteId, newToken, expiresAt).run();
      tokenRow = { token: newToken, expires_at: expiresAt };
    }

    return json({
      token: tokenRow.token,
      url: `/phpmyadmin-lite.html?token=${tokenRow.token}`,
      expiresAt: tokenRow.expires_at,
    });
  }


  // ---------- phpMyAdmin: WP 스키마 조회 ----------
  const pmaTablesMatch = pathname.match(/^\/api\/pma\/tables$/);
  if (pmaTablesMatch && method === "GET") {
    // pma 세션 검증
    const auth = request.headers.get("Authorization") || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return err("인증이 필요해요.", 401);
    const payload = await verifyJWT(match[1], env.JWT_SECRET);
    if (!payload || !payload.pma) return err("phpMyAdmin 세션이 유효하지 않아요.", 401);
    const siteId = payload.sub;

    const wpTables = [
      "wp_options", "wp_users", "wp_usermeta", "wp_posts", "wp_postmeta",
      "wp_terms", "wp_term_taxonomy", "wp_term_relationships",
      "wp_comments", "wp_commentmeta", "wp_links",
    ];

    const tableData = {};
    for (const t of wpTables) {
      try {
        const { results } = await env.DB.prepare(`SELECT * FROM ${t} WHERE site_id = ? LIMIT 500`).bind(siteId).all();
        tableData[t] = results;
      } catch (e) {
        tableData[t] = [];
      }
    }

    return json({ tables: tableData });
  }

  // ---------- 호스팅 접속 정보 ----------
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

    // phpMyAdmin 토큰 조회
    const now = Math.floor(Date.now() / 1000);
    let pmaToken = await env.DB.prepare(
      "SELECT token FROM phpmyadmin_tokens WHERE site_id = ? AND expires_at > ?"
    ).bind(siteId, now).first();

    if (!pmaToken) {
      const newToken = randomToken();
      const expiresAt = kstMidnightTimestamp();
      await env.DB.prepare(
        "INSERT INTO phpmyadmin_tokens (id, site_id, token, expires_at) VALUES (?, ?, ?, ?)"
      ).bind(uid(), siteId, newToken, expiresAt).run();
      pmaToken = { token: newToken };
    }

    const pmaUrl = `/phpmyadmin-lite.html?token=${pmaToken.token}`;

    return json({
      provisioned: true,
      phpmyadmin: {
        username: row.phpmyadmin_username,
        password: pmaPassword,
        url: pmaUrl,
        dbPath: row.db_path,
        note: "접속 링크는 매일 자정(KST) 초기화돼요.",
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

  // ---------- 파일 관리자 ----------
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
      return json({ type: "file", path: data.path, size: data.size, encoding: data.encoding, content: data.content });
    }

    if (method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const { path: filePath, content, message } = body;
      if (!filePath || content === undefined) return err("path와 content가 필요합니다.");
      await gh.putFileBase64(githubToken, owner, repo, filePath, content, message || `chore: update ${filePath}`);
      return json({ ok: true });
    }

    if (method === "DELETE") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return err("path가 필요합니다.");
      await gh.deleteFile(githubToken, owner, repo, filePath, `chore: delete ${filePath}`);
      return json({ ok: true });
    }
  }

  // ---------- WP 게시물 관리 (글/페이지 → Blogspot + GitHub 동시 저장) ----------
  const postsMatch = pathname.match(/^\/api\/sites\/([^/]+)\/posts$/);
  if (postsMatch) {
    const siteId = postsMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM wp_posts WHERE site_id = ? AND post_status != 'trash' ORDER BY post_date DESC LIMIT 100"
      ).bind(siteId).all();
      return json({ posts: results });
    }

    if (method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { title, content, status = "publish", postType = "post" } = body;
      if (!title) return err("제목을 입력해주세요.");

      const cred = await env.DB.prepare("SELECT * FROM user_credentials WHERE user_id = ?").bind(userId).first();
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");

      // Blogspot에 게시물 생성 (콘텐츠 저장)
      let bloggerPostId = null;
      if (cred?.gcp_blogger_token_enc && site.blogger_blog_id) {
        try {
          const bloggerToken = await decryptSecret(env, cred.gcp_blogger_token_enc);
          const post = await blogger.createPost(bloggerToken, site.blogger_blog_id, title, content || "");
          bloggerPostId = post?.id || null;
        } catch (e) {
          // Blogspot 저장 실패해도 DB에는 저장
        }
      }

      // GitHub에도 마크다운으로 저장
      let githubPath = null;
      if (cred?.github_token_enc && site.github_repo) {
        try {
          const githubToken = await decryptSecret(env, cred.github_token_enc);
          const [owner, repo] = site.github_repo.split("/");
          const slug = slugify(title);
          const mdPath = `content/posts/${now.slice(0, 10)}-${slug}.md`;
          const mdContent = `---\ntitle: "${title}"\ndate: "${now}"\nstatus: "${status}"\n---\n\n${content || ""}`;
          await gh.putFile(githubToken, owner, repo, mdPath, mdContent, `post: ${title}`);
          githubPath = mdPath;
        } catch (e) {
          // GitHub 저장 실패해도 계속
        }
      }

      // wp_posts DB에 메타데이터 저장
      const postSlug = slugify(title);
      await env.DB.prepare(
        `INSERT INTO wp_posts
         (site_id, post_author, post_date, post_date_gmt, post_title, post_name,
          post_status, post_type, blogger_post_id, github_path, post_modified, post_modified_gmt)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(siteId, now, now, title, postSlug, status, postType, bloggerPostId, githubPath, now, now).run();

      return json({ ok: true, bloggerPostId, githubPath });
    }
  }

  // ---------- WP 옵션 (사이트 기본 정보) ----------
  const optionsMatch = pathname.match(/^\/api\/sites\/([^/]+)\/options$/);
  if (optionsMatch) {
    const siteId = optionsMatch[1];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT option_name, option_value FROM wp_options WHERE site_id = ?"
      ).bind(siteId).all();
      const opts = {};
      for (const r of results) opts[r.option_name] = r.option_value;
      return json({ options: opts });
    }

    if (method === "PUT") {
      const body = await request.json().catch(() => ({}));
      for (const [k, v] of Object.entries(body)) {
        await env.DB.prepare(
          "INSERT INTO wp_options (site_id, option_name, option_value) VALUES (?, ?, ?) ON CONFLICT(site_id, option_name) DO UPDATE SET option_value = excluded.option_value"
        ).bind(siteId, k, String(v)).run();
      }
      return json({ ok: true });
    }
  }

  // ---------- database (레거시: SQLite 파일 직접 R/W) ----------
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
        return err(`데이터베이스 파일을 찾을 수 없습니다 (${dbPath}).`, 404);
      }
    }

    if (method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const { content } = body;
      if (!content) return err("content(base64)가 필요합니다.");
      await gh.putFileBase64(githubToken, owner, repo, dbPath, content, "chore: update wordpress.db via phpMyAdmin");
      return json({ ok: true });
    }
  }

  return err("Not found", 404);
}


