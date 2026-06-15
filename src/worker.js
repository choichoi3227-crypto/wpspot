// src/worker.js — wpspot Cloudflare Worker

import { signJWT, verifyJWT, hashPassword, verifyPassword, getUserFromRequest } from "./auth.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import * as gh from "./github.js";
import * as cf from "./cf.js";
import { generateUsername, generatePassword } from "./credentials.js";
import { slugify, initWpOptions } from "./utils.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function err(message, status = 400) { return json({ error: message }, status); }
function uid() { return crypto.randomUUID(); }

function kstMidnightTimestamp() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCHours(15, 0, 0, 0);
  if (kst.getTime() <= now.getTime()) kst.setUTCDate(kst.getUTCDate() + 1);
  return Math.floor(kst.getTime() / 1000);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
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

  // ── 인증 ─────────────────────────────────────────────────────────────────

  if (pathname === "/api/auth/signup" && method === "POST") {
    const { email, password, displayName } = await request.json().catch(() => ({}));
    if (!email || !password || password.length < 8)
      return err("이메일과 8자 이상의 비밀번호를 입력해주세요.");
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (existing) return err("이미 가입된 이메일입니다.", 409);
    const id = uid();
    await env.DB.prepare(
      "INSERT INTO users (id,email,password_hash,display_name) VALUES (?,?,?,?)"
    ).bind(id, email, await hashPassword(password), displayName || "").run();
    const token = await signJWT({ sub: id, email }, env.JWT_SECRET);
    return json({ token, user: { id, email, displayName: displayName || "" } });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const { email, password } = await request.json().catch(() => ({}));
    if (!email || !password) return err("이메일과 비밀번호를 입력해주세요.");
    const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (!user || !await verifyPassword(password, user.password_hash))
      return err("이메일 또는 비밀번호가 올바르지 않습니다.", 401);
    const token = await signJWT({ sub: user.id, email: user.email }, env.JWT_SECRET);
    return json({ token, user: { id: user.id, email: user.email, displayName: user.display_name } });
  }

  // ── PHPLiteAdmin 토큰 인증 (공개) ────────────────────────────────────────

  const plaAuthMatch = pathname.match(/^\/api\/pla\/([^/]+)\/auth$/);
  if (plaAuthMatch && method === "POST") {
    const token = plaAuthMatch[1];
    const { password } = await request.json().catch(() => ({}));
    const now = Math.floor(Date.now() / 1000);
    const tokenRow = await env.DB.prepare(
      "SELECT * FROM pla_tokens WHERE token=? AND expires_at>?"
    ).bind(token, now).first();
    if (!tokenRow) return err("접속 링크가 만료됐거나 유효하지 않아요.", 401);
    const cred = await env.DB.prepare(
      "SELECT * FROM site_credentials WHERE site_id=?"
    ).bind(tokenRow.site_id).first();
    if (!cred) return err("사이트 자격증명을 찾을 수 없어요.", 404);
    if (!await verifyPassword(password, cred.pla_password_hash))
      return err("비밀번호가 올바르지 않아요.", 401);
    const sessionToken = await signJWT({ sub: tokenRow.site_id, pla: true }, env.JWT_SECRET, 3600);
    return json({ ok: true, sessionToken, siteId: tokenRow.site_id });
  }

  // ── GitHub Actions 콜백 (터널 URL 등록, 공개 엔드포인트) ─────────────────

  if (pathname === "/api/callback/tunnel" && method === "POST") {
    const authHdr = request.headers.get("Authorization") || "";
    const match = authHdr.match(/^Bearer\s+(.+)$/i);
    if (!match) return err("인증 필요", 401);
    const payload = await verifyJWT(match[1], env.JWT_SECRET);
    if (!payload) return err("JWT 검증 실패", 401);

    const body = await request.json().catch(() => ({}));
    const { siteId, tunnelWpUrl, tunnelPlaUrl, status } = body;
    if (!siteId) return err("siteId가 필요합니다.");

    // userId 확인 (site 소유자가 발급한 JWT)
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id=?").bind(siteId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    // 터널 URL 및 상태 업데이트
    const updates = [];
    const binds = [];
    if (tunnelWpUrl)  { updates.push("cf_worker_url=?");  binds.push(tunnelWpUrl); }
    if (tunnelPlaUrl) { updates.push("tunnel_pla_url=?"); binds.push(tunnelPlaUrl); }
    if (status)       { updates.push("status=?");         binds.push(status); }
    updates.push("updated_at=strftime('%s','now')");
    if (updates.length > 1) {
      await env.DB.prepare(
        `UPDATE sites SET ${updates.join(",")} WHERE id=?`
      ).bind(...binds, siteId).run();
    }

    // site_credentials nginx_status 업데이트
    if (status === "active") {
      await env.DB.prepare(
        "UPDATE site_credentials SET nginx_status='active' WHERE site_id=?"
      ).bind(siteId).run().catch(() => {});
    }

    return json({ ok: true });
  }

  // ── 이하 로그인 필요 ──────────────────────────────────────────────────────

  const authUser = await getUserFromRequest(request, env);
  if (!authUser) return err("로그인이 필요합니다.", 401);
  const userId = authUser.sub;

  // ── 계정 자격증명 ─────────────────────────────────────────────────────────

  if (pathname === "/api/account/credentials" && method === "GET") {
    const row = await env.DB.prepare(
      `SELECT cf_account_email, cf_account_id,
              github_token_enc, cf_global_api_key_enc, cf_api_token_enc
       FROM user_credentials WHERE user_id=?`
    ).bind(userId).first();
    return json({
      cfAccountEmail: row?.cf_account_email || "",
      cfAccountId: row?.cf_account_id || "",
      hasGithubToken: !!row?.github_token_enc,
      hasCfGlobalApiKey: !!row?.cf_global_api_key_enc,
      hasCfApiToken: !!row?.cf_api_token_enc,
    });
  }

  if (pathname === "/api/account/credentials" && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const { githubToken, cfGlobalApiKey, cfAccountEmail, cfAccountId, cfApiToken } = body;
    const githubEnc       = githubToken    ? await encryptSecret(env, githubToken)    : undefined;
    const cfKeyEnc        = cfGlobalApiKey ? await encryptSecret(env, cfGlobalApiKey) : undefined;
    const cfApiTokenEnc   = cfApiToken     ? await encryptSecret(env, cfApiToken)     : undefined;
    const existing = await env.DB.prepare(
      "SELECT user_id FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (existing) {
      const sets = [], binds = [];
      if (githubEnc !== undefined)      { sets.push("github_token_enc=?");      binds.push(githubEnc); }
      if (cfKeyEnc !== undefined)       { sets.push("cf_global_api_key_enc=?"); binds.push(cfKeyEnc); }
      if (cfApiTokenEnc !== undefined)  { sets.push("cf_api_token_enc=?");      binds.push(cfApiTokenEnc); }
      if (cfAccountEmail !== undefined) { sets.push("cf_account_email=?");      binds.push(cfAccountEmail); }
      if (cfAccountId !== undefined)    { sets.push("cf_account_id=?");         binds.push(cfAccountId); }
      if (!sets.length) return json({ ok: true });
      sets.push("updated_at=strftime('%s','now')");
      await env.DB.prepare(`UPDATE user_credentials SET ${sets.join(",")} WHERE user_id=?`)
        .bind(...binds, userId).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO user_credentials
         (user_id,github_token_enc,cf_global_api_key_enc,cf_api_token_enc,
          cf_account_email,cf_account_id)
         VALUES (?,?,?,?,?,?)`
      ).bind(userId,
        githubEnc || null, cfKeyEnc || null, cfApiTokenEnc || null,
        cfAccountEmail || null, cfAccountId || null
      ).run();
    }
    return json({ ok: true });
  }

  // ── 사이트 목록 ───────────────────────────────────────────────────────────

  if (pathname === "/api/sites" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, site_name, site_slug, github_repo, cf_worker_url, tunnel_pla_url,
              status, custom_domain, cf_zone_id, created_at
       FROM sites WHERE user_id=? ORDER BY created_at DESC`
    ).bind(userId).all();
    return json({ sites: results });
  }

  // ── 사이트 생성 ───────────────────────────────────────────────────────────

  if (pathname === "/api/sites" && method === "POST") {
    const { siteName } = await request.json().catch(() => ({}));
    if (!siteName || siteName.trim().length < 1) return err("사이트 이름을 입력해주세요.");
    if (siteName.trim().length > 60) return err("사이트 이름은 60자 이하로 입력해주세요.");
    const siteSlug = slugify(siteName.trim());
    if (siteSlug.length < 3) return err("사이트 이름이 너무 짧아요. 더 길게 입력해주세요.");
    const id = uid();
    await env.DB.prepare(
      "INSERT INTO sites (id,user_id,site_name,site_slug,status) VALUES (?,?,?,?,'pending')"
    ).bind(id, userId, siteName.trim(), siteSlug).run();
    return json({ id, siteName: siteName.trim(), siteSlug, status: "pending" });
  }

  // ── 사이트 삭제 ───────────────────────────────────────────────────────────

  const siteIdMatch = pathname.match(/^\/api\/sites\/([^/]+)$/);
  if (siteIdMatch && method === "DELETE") {
    const siteId = siteIdMatch[1];
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    try {
      const cred = await env.DB.prepare(
        "SELECT * FROM user_credentials WHERE user_id=?"
      ).bind(userId).first();
      if (cred?.github_token_enc && site.github_repo) {
        const token = await decryptSecret(env, cred.github_token_enc);
        const [owner, repo] = site.github_repo.split("/");
        await gh.deleteRepo(token, owner, repo).catch(() => {});
      }
    } catch (_) {}
    const wpTables = [
      "wp_commentmeta","wp_comments","wp_term_relationships","wp_term_taxonomy",
      "wp_terms","wp_postmeta","wp_posts","wp_usermeta","wp_users",
      "wp_options","wp_links",
    ];
    for (const t of wpTables) {
      await env.DB.prepare(`DELETE FROM ${t} WHERE site_id=?`).bind(siteId).run().catch(() => {});
    }
    await env.DB.prepare("DELETE FROM pla_tokens WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_credentials WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_jobs WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_domains WHERE cf_zone_id=? AND user_id=?").bind(site.cf_zone_id || "", userId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM sites WHERE id=?").bind(siteId).run();
    return json({ ok: true });
  }

  // ── 프로비저닝 ────────────────────────────────────────────────────────────

  const provisionMatch = pathname.match(/^\/api\/sites\/([^/]+)\/provision$/);
  if (provisionMatch && method === "POST") {
    const siteId = provisionMatch[1];
    const body = await request.json().catch(() => ({}));
    const { customDomain, zoneId } = body;

    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    if (!customDomain) return err("개인 도메인이 필요합니다.", 400);

    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.github_token_enc)
      return err("GitHub Token을 먼저 등록해주세요.", 400);
    if (!cred?.cf_global_api_key_enc || !cred?.cf_account_email)
      return err("Cloudflare Global API Key와 이메일을 먼저 등록해주세요.", 400);

    const jobId = uid();
    await env.DB.prepare(
      "INSERT INTO site_jobs (id,site_id,job_type,status) VALUES (?,?,'provision','running')"
    ).bind(jobId, siteId).run();
    await env.DB.prepare(
      "UPDATE sites SET status='provisioning', custom_domain=?, cf_zone_id=?, updated_at=strftime('%s','now') WHERE id=?"
    ).bind(customDomain, zoneId || null, siteId).run();

    try {
      const githubToken = await decryptSecret(env, cred.github_token_enc);
      const cfKey       = await decryptSecret(env, cred.cf_global_api_key_enc);
      const cfApiToken  = cred.cf_api_token_enc
        ? await decryptSecret(env, cred.cf_api_token_enc).catch(() => "")
        : "";

      // CF Account ID 확보
      let accountId = cred.cf_account_id;
      if (!accountId) {
        accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
        await env.DB.prepare(
          "UPDATE user_credentials SET cf_account_id=? WHERE user_id=?"
        ).bind(accountId, userId).run();
      }

      // GitHub 레포 생성
      const ghUser   = await gh.getAuthenticatedUser(githubToken);
      const repoName = `wpspot-${site.site_slug}`;
      await gh.createRepo(githubToken, repoName);
      const repoFullName = `${ghUser.login}/${repoName}`;

      // CF Worker subdomain
      const workerSubdomain = await cf.getWorkerSubdomain(cred.cf_account_email, cfKey, accountId);
      const workerName      = `wpspot-${site.site_slug}`;
      const workerUrl       = `https://${workerName}.${workerSubdomain}.workers.dev`;

      // 사용자 자격증명 생성
      const wpAdminUser    = generateUsername();
      const wpAdminPass    = generatePassword();
      const plaPass        = generatePassword();
      const plaPassHash    = await hashPassword(plaPass);
      const plaPassEnc     = await encryptSecret(env, plaPass);
      const wpAdminPassEnc = await encryptSecret(env, wpAdminPass);

      // 콜백용 단기 JWT (사이트 ID 포함, 1시간)
      const callbackJwt = await signJWT(
        { sub: userId, siteId, callback: true },
        env.JWT_SECRET,
        3600
      );
      const callbackUrl = `${env.WPSPOT_BASE_URL || "https://wpspot.workers.dev"}/api/callback/tunnel`;

      // 워크플로우 파일 로드
      const [provisionYml, keepaliveYml] = await Promise.all([
        env.ASSETS.fetch(new Request("https://wpspot.app/_internal/workflows/provision.yml"))
          .then(r => r.ok ? r.text() : Promise.reject(new Error("provision.yml 로드 실패"))),
        env.ASSETS.fetch(new Request("https://wpspot.app/_internal/workflows/nginx-keepalive.yml"))
          .then(r => r.ok ? r.text() : "").catch(() => ""),
      ]);

      // 초기 커밋 (워크플로우 + 빈 deploy 디렉토리 placeholder)
      await gh.createInitialCommit(githubToken, ghUser.login, repoName, [
        { path: ".github/workflows/provision.yml",       content: provisionYml },
        { path: ".github/workflows/nginx-keepalive.yml", content: keepaliveYml || "# keepalive" },
        { path: "deploy/.gitkeep",                       content: "" },
        { path: "deploy/.worker_name",                   content: workerName },
      ], "chore: initial wpspot setup");

      // 10초 대기 후 워크플로우 dispatch
      await new Promise(r => setTimeout(r, 10000));

      await gh.dispatchWorkflow(githubToken, ghUser.login, repoName, "provision.yml", "main", {
        site_slug:             site.site_slug,
        site_display_name:     site.site_name,
        custom_domain:         customDomain,
        pma_domain:            `pma.${customDomain}`,
        wp_admin_user:         wpAdminUser,
        wp_admin_pass:         wpAdminPass,
        secret_cf_account_id:  accountId,
        secret_cf_api_token:   cfApiToken,
        secret_github_token:   githubToken,
        secret_worker_name:    workerName,
        wpspot_callback_url:   callbackUrl,
        wpspot_site_id:        siteId,
        wpspot_jwt:            callbackJwt,
      });

      // DB 업데이트
      await env.DB.prepare(
        `UPDATE sites SET github_repo=?, cf_worker_url=?, cf_worker_name=?,
         updated_at=strftime('%s','now') WHERE id=?`
      ).bind(repoFullName, workerUrl, workerName, siteId).run();

      const existingCred = await env.DB.prepare(
        "SELECT site_id FROM site_credentials WHERE site_id=?"
      ).bind(siteId).first();
      if (!existingCred) {
        await env.DB.prepare(
          `INSERT INTO site_credentials
           (site_id,pla_username,pla_password_hash,pla_password_plain_enc,
            wp_admin_username,wp_admin_password_plain_enc,db_path,nginx_status)
           VALUES (?,?,?,?,?,?,?,'provisioning')`
        ).bind(
          siteId, "admin", plaPassHash, plaPassEnc,
          wpAdminUser, wpAdminPassEnc,
          "wp-content/database/wordpress.db"
        ).run();
      }

      await initWpOptions(env.DB, siteId, site.site_name, `https://${customDomain}`);

      // Zone에 Worker Route 연결
      if (zoneId) {
        await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `${customDomain}/*`, workerName)
          .catch(() => {});
        await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `www.${customDomain}/*`, workerName)
          .catch(() => {});
        await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `pma.${customDomain}/*`, `${workerName}-pma`)
          .catch(() => {});
      }

      await env.DB.prepare(
        "UPDATE site_jobs SET status='success', message=?, finished_at=strftime('%s','now') WHERE id=?"
      ).bind("프로비저닝 요청 완료. GitHub Actions가 실행 중이에요.", jobId).run();

      return json({
        ok: true,
        workerUrl,
        githubRepo:  repoFullName,
        customDomain,
        pmaDomain:   `pma.${customDomain}`,
        nextStep:    "GitHub Actions provision 워크플로우가 WordPress를 설치하고 있어요. 약 3~5분 후 사이트가 활성화됩니다.",
      });
    } catch (e) {
      console.error("Provision error:", e.message, e.stack);
      await env.DB.prepare(
        "UPDATE sites SET status='error', updated_at=strftime('%s','now') WHERE id=?"
      ).bind(siteId).run();
      await env.DB.prepare(
        "UPDATE site_jobs SET status='failed', message=?, finished_at=strftime('%s','now') WHERE id=?"
      ).bind(String(e.message).slice(0, 500), jobId).run();
      return err(`프로비저닝 실패: ${e.message}`, 500);
    }
  }

  // ── 도메인 연결 ───────────────────────────────────────────────────────────

  const connectMatch = pathname.match(/^\/api\/sites\/([^/]+)\/connect-domain$/);
  if (connectMatch && method === "POST") {
    const siteId = connectMatch[1];
    const { customDomain, zoneId } = await request.json().catch(() => ({}));
    if (!customDomain || !zoneId) return err("customDomain과 zoneId가 필요합니다.");
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc) return err("Cloudflare API 키가 필요합니다.", 400);
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    const workerName = site.cf_worker_name;
    if (workerName) {
      await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `${customDomain}/*`, workerName).catch(() => {});
      await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `www.${customDomain}/*`, workerName).catch(() => {});
      await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `pma.${customDomain}/*`, `${workerName}-pma`).catch(() => {});
    }
    await env.DB.prepare(
      "UPDATE sites SET custom_domain=?, cf_zone_id=?, updated_at=strftime('%s','now') WHERE id=?"
    ).bind(customDomain, zoneId, siteId).run();
    return json({ ok: true, customDomain, pmaDomain: `pma.${customDomain}` });
  }

  // ── 캐시 퍼지 ─────────────────────────────────────────────────────────────

  const purgeMatch = pathname.match(/^\/api\/sites\/([^/]+)\/purge-cache$/);
  if (purgeMatch && method === "POST") {
    const siteId = purgeMatch[1];
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    if (!site.cf_zone_id) return err("연결된 Zone이 없습니다.", 400);
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc) return err("Cloudflare API 키가 필요합니다.", 400);
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    await cf.purgeCache(cred.cf_account_email, cfKey, site.cf_zone_id);
    return json({ ok: true });
  }

  // ── 호스팅 접속 정보 ──────────────────────────────────────────────────────

  const credInfoMatch = pathname.match(/^\/api\/sites\/([^/]+)\/credentials$/);
  if (credInfoMatch && method === "GET") {
    const siteId = credInfoMatch[1];
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    const row = await env.DB.prepare(
      "SELECT * FROM site_credentials WHERE site_id=?"
    ).bind(siteId).first();
    if (!row) return json({ provisioned: false });

    const plaPass = row.pla_password_plain_enc
      ? await decryptSecret(env, row.pla_password_plain_enc)
      : null;
    const wpPass = row.wp_admin_password_plain_enc
      ? await decryptSecret(env, row.wp_admin_password_plain_enc)
      : null;

    // PLA 토큰 발급/조회
    const now = Math.floor(Date.now() / 1000);
    let plaToken = await env.DB.prepare(
      "SELECT token FROM pla_tokens WHERE site_id=? AND expires_at>?"
    ).bind(siteId, now).first();
    if (!plaToken) {
      const newToken = randomToken();
      await env.DB.prepare(
        "INSERT INTO pla_tokens (id,site_id,token,expires_at) VALUES (?,?,?,?)"
      ).bind(uid(), siteId, newToken, kstMidnightTimestamp()).run();
      plaToken = { token: newToken };
    }

    const customDomain = site.custom_domain;
    const plaUrl   = customDomain ? `https://pma.${customDomain}` : (site.tunnel_pla_url || null);
    const adminUrl = customDomain
      ? `https://${customDomain}/wp-admin`
      : (site.cf_worker_url ? `${site.cf_worker_url}/wp-admin` : null);

    return json({
      provisioned: true,
      pla: {
        url:         plaUrl,
        fallbackUrl: `/phpliteadmin-lite.html?token=${plaToken.token}`,
        username:    row.pla_username || "admin",
        password:    plaPass,
        dbPath:      row.db_path,
      },
      wordpress: {
        adminUrl,
        username: row.wp_admin_username,
        password: wpPass,
        status:   row.nginx_status,
      },
      nginx: {
        status:    row.nginx_status,
        workerUrl: site.cf_worker_url,
      },
      domain: {
        customDomain: site.custom_domain,
        pmaDomain:    customDomain ? `pma.${customDomain}` : null,
        tunnelWpUrl:  site.cf_worker_url,
        tunnelPlaUrl: site.tunnel_pla_url,
      },
    });
  }

  // ── PHPLiteAdmin 데이터 ───────────────────────────────────────────────────

  if (pathname === "/api/pla/tables" && method === "GET") {
    const auth = request.headers.get("Authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return err("인증이 필요해요.", 401);
    const p = await verifyJWT(m[1], env.JWT_SECRET);
    if (!p || !p.pla) return err("세션이 유효하지 않아요.", 401);
    const siteId = p.sub;
    const wpTables = [
      "wp_options","wp_users","wp_usermeta","wp_posts","wp_postmeta",
      "wp_terms","wp_term_taxonomy","wp_term_relationships",
      "wp_comments","wp_commentmeta","wp_links",
    ];
    const tableData = {};
    for (const t of wpTables) {
      try {
        const { results } = await env.DB.prepare(
          `SELECT * FROM ${t} WHERE site_id=? LIMIT 500`
        ).bind(siteId).all();
        tableData[t] = results;
      } catch { tableData[t] = []; }
    }
    return json({ tables: tableData });
  }

  if (pathname === "/api/pla/update" && method === "POST") {
    const auth = request.headers.get("Authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return err("인증이 필요해요.", 401);
    const p = await verifyJWT(m[1], env.JWT_SECRET);
    if (!p || !p.pla) return err("세션이 유효하지 않아요.", 401);
    const { table, pk, pkValue, field: fieldName, value } = await request.json().catch(() => ({}));
    const allowed = [
      "wp_options","wp_users","wp_usermeta","wp_posts","wp_postmeta",
      "wp_terms","wp_term_taxonomy","wp_comments","wp_commentmeta","wp_links",
    ];
    if (!allowed.includes(table)) return err("허용되지 않은 테이블입니다.");
    if (!pk || !fieldName) return err("pk, field가 필요합니다.");
    await env.DB.prepare(
      `UPDATE ${table} SET ${fieldName}=? WHERE ${pk}=? AND site_id=?`
    ).bind(value, pkValue, p.sub).run();
    return json({ ok: true });
  }

  if (pathname === "/api/pla/delete" && method === "POST") {
    const auth = request.headers.get("Authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return err("인증이 필요해요.", 401);
    const p = await verifyJWT(m[1], env.JWT_SECRET);
    if (!p || !p.pla) return err("세션이 유효하지 않아요.", 401);
    const { table, pk, pkValue } = await request.json().catch(() => ({}));
    const allowed = [
      "wp_options","wp_users","wp_usermeta","wp_posts","wp_postmeta",
      "wp_terms","wp_term_taxonomy","wp_comments","wp_commentmeta","wp_links",
    ];
    if (!allowed.includes(table)) return err("허용되지 않은 테이블입니다.");
    await env.DB.prepare(
      `DELETE FROM ${table} WHERE ${pk}=? AND site_id=?`
    ).bind(pkValue, p.sub).run();
    return json({ ok: true });
  }

  // ── 파일 관리자 ───────────────────────────────────────────────────────────

  const filesMatch = pathname.match(/^\/api\/sites\/([^/]+)\/files$/);
  if (filesMatch) {
    const siteId = filesMatch[1];
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    if (!site.github_repo) return err("아직 프로비저닝되지 않은 사이트입니다.", 400);
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.github_token_enc) return err("GitHub Token이 없습니다.", 400);
    const githubToken = await decryptSecret(env, cred.github_token_enc);
    const [owner, repo] = site.github_repo.split("/");
    if (method === "GET") {
      const filePath = url.searchParams.get("path") || "";
      const data = await gh.getContents(githubToken, owner, repo, filePath);
      if (Array.isArray(data)) {
        return json({ type: "dir", path: filePath,
          items: data.map(it => ({ name: it.name, path: it.path, type: it.type, size: it.size })) });
      }
      return json({ type: "file", path: data.path, size: data.size, encoding: data.encoding, content: data.content });
    }
    if (method === "PUT") {
      const { path: filePath, content, message } = await request.json().catch(() => ({}));
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

  // ── 도메인 관리 ───────────────────────────────────────────────────────────

  if (pathname === "/api/domains" && method === "GET") {
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc || !cred?.cf_account_email) return json({ zones: [] });
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    const zones = await cf.listZones(cred.cf_account_email, cfKey);
    return json({ zones });
  }

  if (pathname === "/api/domains" && method === "POST") {
    const { domainName } = await request.json().catch(() => ({}));
    if (!domainName) return err("도메인 이름이 필요합니다.");
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc || !cred?.cf_account_email)
      return err("Cloudflare API 키가 필요합니다.", 400);
    let accountId = cred.cf_account_id;
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    if (!accountId) {
      accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
      await env.DB.prepare(
        "UPDATE user_credentials SET cf_account_id=? WHERE user_id=?"
      ).bind(accountId, userId).run();
    }
    const zone = await cf.addZone(cred.cf_account_email, cfKey, accountId, domainName);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO site_domains (id,user_id,domain_name,cf_zone_id,status,name_servers) VALUES (?,?,?,?,?,?)"
    ).bind(uid(), userId, domainName, zone.id, "pending",
      JSON.stringify(zone.name_servers || [])
    ).run();
    return json({ ok: true, zone });
  }

  const domainDeleteMatch = pathname.match(/^\/api\/domains\/([^/]+)$/);
  if (domainDeleteMatch && method === "DELETE") {
    const zoneId = domainDeleteMatch[1];
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc) return err("Cloudflare API 키가 필요합니다.", 400);
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    await cf.deleteZone(cred.cf_account_email, cfKey, zoneId);
    await env.DB.prepare(
      "DELETE FROM site_domains WHERE cf_zone_id=? AND user_id=?"
    ).bind(zoneId, userId).run();
    return json({ ok: true });
  }

  // ── DNS 관리 ──────────────────────────────────────────────────────────────

  const dnsMatch = pathname.match(/^\/api\/domains\/([^/]+)\/dns$/);
  if (dnsMatch) {
    const zoneId = dnsMatch[1];
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc) return err("Cloudflare API 키가 필요합니다.", 400);
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    if (method === "GET") {
      const records = await cf.listDnsRecords(cred.cf_account_email, cfKey, zoneId);
      return json({ records });
    }
    if (method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.type === "ALIAS") {
        if (!body.workerName) return err("ALIAS 타입에는 workerName이 필요합니다.");
        const route = await cf.addWorkerRoute(
          cred.cf_account_email, cfKey, zoneId, `${body.name}/*`, body.workerName
        );
        return json({ ok: true, route, type: "ALIAS" });
      }
      const record = await cf.createDnsRecord(cred.cf_account_email, cfKey, zoneId, body);
      return json({ ok: true, record });
    }
  }

  const dnsRecordMatch = pathname.match(/^\/api\/domains\/([^/]+)\/dns\/([^/]+)$/);
  if (dnsRecordMatch) {
    const [, zoneId, recordId] = dnsRecordMatch;
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc) return err("Cloudflare API 키가 필요합니다.", 400);
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    if (method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      const record = await cf.updateDnsRecord(cred.cf_account_email, cfKey, zoneId, recordId, body);
      return json({ ok: true, record });
    }
    if (method === "DELETE") {
      await cf.deleteDnsRecord(cred.cf_account_email, cfKey, zoneId, recordId);
      return json({ ok: true });
    }
  }

  const routeDeleteMatch = pathname.match(/^\/api\/domains\/([^/]+)\/routes\/([^/]+)$/);
  if (routeDeleteMatch && method === "DELETE") {
    const [, zoneId, routeId] = routeDeleteMatch;
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc) return err("Cloudflare API 키가 필요합니다.", 400);
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
    await cf.deleteWorkerRoute(cred.cf_account_email, cfKey, zoneId, routeId);
    return json({ ok: true });
  }

  return err("Not found", 404);
}
