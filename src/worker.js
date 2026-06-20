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

// 301 리다이렉트 전용 경량 Worker 코드 생성 (alias 도메인 → primary 도메인)
function buildRedirectWorkerJs(targetHostname) {
  return `export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = ${JSON.stringify(targetHostname)};
    url.protocol = "https:";
    return Response.redirect(url.toString(), 301);
  }
};`;
}

// 사이트에 도메인을 연결하고 GitHub Actions 프로비저닝을 시작한다.
// /api/sites/:id/provision 과 /api/sites/:id/domains(Primary 최초 등록) 양쪽에서 공유.
async function provisionSite(env, userId, site, customDomain, zoneId) {
  const siteId = site.id;
  const cred = await env.DB.prepare(
    "SELECT * FROM user_credentials WHERE user_id=?"
  ).bind(userId).first();
  if (!cred?.github_token_enc)
    return err("GitHub Token을 먼저 등록해주세요.", 400);
  if (!cred?.cf_global_api_key_enc || !cred?.cf_account_email)
    return err("Cloudflare Global API Key와 이메일을 먼저 등록해주세요.", 400);
  if (!cred?.cf_api_token_enc)
    return err("Cloudflare API Token이 필요합니다. (Workers 자동 배포에 필수 — 내 계정에서 등록해주세요)", 400);

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
    let ghUser;
    try {
      ghUser = await gh.getAuthenticatedUser(githubToken);
    } catch (e) {
      // 토큰이 GitHub에 의해 거부됨 — 계정 화면에서 바로 보이도록 플래그를 세운다.
      await env.DB.prepare(
        "UPDATE user_credentials SET github_token_invalid=1 WHERE user_id=?"
      ).bind(userId).run().catch(() => {});
      throw new Error(
        `GitHub 인증 실패 (${e.message}). 등록된 GitHub Token이 만료되었거나 취소됐을 수 있어요. ` +
        `내 계정 → GitHub Token에서 새 토큰을 발급받아 다시 등록해주세요.`
      );
    }
    const repoName = `wpspot-${site.site_slug}`;
    await gh.createRepo(githubToken, repoName);
    const repoFullName = `${ghUser.login}/${repoName}`;

    // CF Worker subdomain — workers.dev 서브도메인은 "임시 접속 URL" 표시용일 뿐,
    // Worker 자체는 Worker Route(커스텀 도메인)로도 충분히 서빙되므로 실패해도 진행한다.
    // (사용자마다 workers.dev 서브도메인을 설정해두지 않은 경우가 흔하므로, 이를 필수로 막으면 안 됨)
    const workerName = `wpspot-${site.site_slug}`;
    let workerUrl = null;
    try {
      const workerSubdomain = await cf.getWorkerSubdomain(cred.cf_account_email, cfKey, accountId);
      workerUrl = `https://${workerName}.${workerSubdomain}.workers.dev`;
    } catch (e) {
      console.error("workers.dev 서브도메인 조회 실패(건너뜀, 커스텀 도메인으로 계속 진행):", e.message);
    }

    // 사용자 자격증명 생성
    const wpAdminUser    = generateUsername();
    const wpAdminPass    = generatePassword();
    const pmaPass        = generatePassword();
    const pmaPassHash    = await hashPassword(pmaPass);
    const pmaPassEnc     = await encryptSecret(env, pmaPass);
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
    const { defaultBranch } = await gh.createInitialCommit(githubToken, ghUser.login, repoName, [
      { path: ".github/workflows/provision.yml",       content: provisionYml },
      { path: ".github/workflows/nginx-keepalive.yml", content: keepaliveYml || "# keepalive" },
      { path: "deploy/.gitkeep",                       content: "" },
      { path: "deploy/.worker_name",                   content: workerName },
    ], "chore: initial wpspot setup");

    await gh.dispatchWorkflow(githubToken, ghUser.login, repoName, "provision.yml", defaultBranch, {
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
      const redisEnabled = 1; // 로컬 Redis 7 — 항상 활성
      await env.DB.prepare(
        `INSERT INTO site_credentials
         (site_id,pla_username,pla_password_hash,pla_password_plain_enc,
          pma_username,pma_password_hash,pma_password_plain_enc,
          wp_admin_username,wp_admin_password_plain_enc,db_path,
          db_engine,db_host,db_port,db_name,db_username,nginx_status,
          redis_enabled,redis_provider,php_main_ports,php_sub_ports,php_active_ports)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'provisioning',?,?,?,?,?)`
      ).bind(
        siteId, "admin", pmaPassHash, pmaPassEnc,
        "admin", pmaPassHash, pmaPassEnc,
        wpAdminUser, wpAdminPassEnc,
        "wordpress@127.0.0.1:3306",
        "MariaDB/MySQL", "127.0.0.1", "3306", "wordpress", "wpuser",
        redisEnabled,
        "Redis 7 (로컬, 무료)",
        "8080",
        "8081",
        "8080,8081"
      ).run();
    }

    await initWpOptions(env.DB, siteId, site.site_name, `https://${customDomain}`);

    // Primary 도메인 바인딩 기록 (멀티 도메인 관리 화면에서 사용)
    const existingBinding = await env.DB.prepare(
      "SELECT id FROM site_domain_bindings WHERE hostname=?"
    ).bind(customDomain).first();
    if (!existingBinding) {
      await env.DB.prepare(
        `INSERT INTO site_domain_bindings (id,site_id,cf_zone_id,hostname,role,status)
         VALUES (?,?,?,?,'primary','active')`
      ).bind(uid(), siteId, zoneId || "", customDomain).run();
    } else {
      await env.DB.prepare(
        "UPDATE site_domain_bindings SET status='active', cf_zone_id=? WHERE hostname=?"
      ).bind(zoneId || "", customDomain).run();
    }

    // 참고: 여기서 DNS/Worker Route를 미리 걸지 않는다.
    // workerName(및 -pma)에 해당하는 실제 Worker 스크립트는 아직 배포되지 않은 상태이며
    // (provision.yml의 "Cloudflare Worker 배포 + 커스텀 도메인 등록" 단계가 3~5분 후
    // wrangler로 배포 + Custom Domain 등록까지 함께 처리함), 이 시점에 Route를 걸면
    // "Worker가 존재하지 않음"(code 10019) 오류만 매번 발생하고 무의미하게 끝난다.

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

  // ── phpMyAdmin 토큰 인증 (공개, 기존 PLA 토큰 테이블 호환) ────────────────

  const pmaAuthMatch = pathname.match(/^\/api\/(?:pma|pla)\/([^/]+)\/auth$/);
  if (pmaAuthMatch && method === "POST") {
    const token = pmaAuthMatch[1];
    const { username, password } = await request.json().catch(() => ({}));
    const now = Math.floor(Date.now() / 1000);
    let tokenRow = await env.DB.prepare(
      "SELECT * FROM pma_tokens WHERE token=? AND expires_at>?"
    ).bind(token, now).first();
    if (!tokenRow) {
      tokenRow = await env.DB.prepare("SELECT * FROM pla_tokens WHERE token=? AND expires_at>?").bind(token, now).first().catch(() => null);
    }
    if (!tokenRow) return err("접속 링크가 만료됐거나 유효하지 않아요.", 401);
    const cred = await env.DB.prepare(
      "SELECT * FROM site_credentials WHERE site_id=?"
    ).bind(tokenRow.site_id).first();
    if (!cred) return err("사이트 자격증명을 찾을 수 없어요.", 404);
    if (username && username !== (cred.pma_username || cred.pla_username || "admin"))
      return err("아이디가 올바르지 않아요.", 401);
    const passwordHash = cred.pma_password_hash || cred.pla_password_hash;
    if (!passwordHash || !await verifyPassword(password, passwordHash))
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
      // 행이 없으면 기본값으로 INSERT 후 UPDATE
      const cred = await env.DB.prepare(
        "SELECT site_id FROM site_credentials WHERE site_id=?"
      ).bind(siteId).first().catch(() => null);
      if (!cred) {
        await env.DB.prepare(
          `INSERT INTO site_credentials
           (site_id, pla_username, pla_password_hash, db_path, nginx_status)
           VALUES (?, 'admin', '', 'wordpress@127.0.0.1:3306', 'active')`
        ).bind(siteId).run().catch(() => {});
      } else {
        await env.DB.prepare(
          "UPDATE site_credentials SET nginx_status='active' WHERE site_id=?"
        ).bind(siteId).run().catch(() => {});
      }
    } else if (status === "setting_up") {
      // GitHub Actions가 DNS/터널/Worker 세팅 단계로 진입했음을 알리는 중간 콜백.
      // (해당 단계까지는 site_credentials 행이 이미 provisionSite()에서 만들어져 있어야 정상이지만,
      //  혹시 없을 경우를 대비해 INSERT … OR IGNORE로 안전하게 처리)
      const cred = await env.DB.prepare(
        "SELECT site_id FROM site_credentials WHERE site_id=?"
      ).bind(siteId).first().catch(() => null);
      if (!cred) {
        await env.DB.prepare(
          `INSERT INTO site_credentials
           (site_id, pla_username, pla_password_hash, db_path, nginx_status)
           VALUES (?, 'admin', '', 'wordpress@127.0.0.1:3306', 'provisioning')`
        ).bind(siteId).run().catch(() => {});
      } else {
        await env.DB.prepare(
          "UPDATE site_credentials SET nginx_status='provisioning' WHERE site_id=?"
        ).bind(siteId).run().catch(() => {});
      }
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
              github_token_enc, github_token_invalid, cf_global_api_key_enc, cf_api_token_enc
       FROM user_credentials WHERE user_id=?`
    ).bind(userId).first();
    return json({
      cfAccountEmail: row?.cf_account_email || "",
      cfAccountId: row?.cf_account_id || "",
      hasGithubToken: !!row?.github_token_enc,
      githubTokenInvalid: !!row?.github_token_invalid,
      hasCfGlobalApiKey: !!row?.cf_global_api_key_enc,
      hasCfApiToken: !!row?.cf_api_token_enc,
    });
  }

  if (pathname === "/api/account/credentials" && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const { githubToken, cfGlobalApiKey, cfAccountEmail, cfAccountId, cfApiToken } = body;

    // GitHub Token은 저장 전에 실제로 유효한지 검증 — 프로비저닝 시점이 아니라
    // 등록 시점에 401/스코프 문제를 바로 알려줘야 함.
    if (githubToken) {
      let ghUser;
      try {
        ghUser = await gh.getAuthenticatedUser(githubToken);
        if (!ghUser?.login) throw new Error("사용자 정보를 확인할 수 없습니다.");
      } catch (e) {
        return err(
          `GitHub Token이 유효하지 않아요: ${e.message}. ` +
          `Settings → Developer settings → Personal access tokens에서 토큰이 만료되지 않았는지, ` +
          `"repo" 권한(Classic) 또는 "Contents: Read and write" + "Administration: Read and write"(Fine-grained) ` +
          `권한이 포함되어 있는지 확인해주세요.`,
          400
        );
      }
      // Classic PAT인 경우 repo/workflow 스코프 확인 (Fine-grained PAT는 _scopes가 빈 배열이라 건너뜀)
      if (ghUser._scopes?.length) {
        const missing = ["repo", "workflow"].filter(s => !ghUser._scopes.includes(s));
        if (missing.length) {
          return err(
            `GitHub Token에 ${missing.map(s => `"${s}"`).join(", ")} 권한이 없어요(현재 권한: ${ghUser._scopes.join(", ") || "없음"}). ` +
            `레포 생성과 워크플로우 실행을 위해 해당 스코프를 추가해서 다시 등록해주세요.`,
            400
          );
        }
      }
    }

    const githubEnc       = githubToken    ? await encryptSecret(env, githubToken)    : undefined;
    const cfKeyEnc        = cfGlobalApiKey ? await encryptSecret(env, cfGlobalApiKey) : undefined;
    const cfApiTokenEnc   = cfApiToken     ? await encryptSecret(env, cfApiToken)     : undefined;
    const existing = await env.DB.prepare(
      "SELECT user_id FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (existing) {
      const sets = [], binds = [];
      if (githubEnc !== undefined)      { sets.push("github_token_enc=?");      binds.push(githubEnc); sets.push("github_token_invalid=0"); }
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
    await env.DB.prepare("DELETE FROM pma_tokens WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM pla_tokens WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_credentials WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_jobs WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_domain_bindings WHERE site_id=?").bind(siteId).run().catch(() => {});
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
    return await provisionSite(env, userId, site, customDomain, zoneId);
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
      // CNAME 대상으로 쓸 workers.dev 호스트 확보 (실패해도 무시하고 자기참조 CNAME으로 진행)
      let cnameTarget = null;
      try {
        let accountId = cred.cf_account_id;
        if (!accountId) accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
        const sub = await cf.getWorkerSubdomain(cred.cf_account_email, cfKey, accountId);
        cnameTarget = `${workerName}.${sub}.workers.dev`;
      } catch (_) {}
      const pmaCnameTarget = cnameTarget ? `${workerName}-pma.${cnameTarget.split(".").slice(1).join(".")}` : null;

      await cf.ensureProxiedRecord(cred.cf_account_email, cfKey, zoneId, customDomain, cnameTarget).catch(() => {});
      await cf.ensureProxiedRecord(cred.cf_account_email, cfKey, zoneId, `www.${customDomain}`, cnameTarget).catch(() => {});
      await cf.ensureProxiedRecord(cred.cf_account_email, cfKey, zoneId, `pma.${customDomain}`, pmaCnameTarget).catch(() => {});
      await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `${customDomain}/*`, workerName).catch(() => {});
      await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `www.${customDomain}/*`, workerName).catch(() => {});
      await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `pma.${customDomain}/*`, `${workerName}-pma`).catch(() => {});
    }
    await env.DB.prepare(
      "UPDATE sites SET custom_domain=?, cf_zone_id=?, updated_at=strftime('%s','now') WHERE id=?"
    ).bind(customDomain, zoneId, siteId).run();
    return json({ ok: true, customDomain, pmaDomain: `pma.${customDomain}` });
  }

  // ── 멀티 도메인 (Primary / Alias) ────────────────────────────────────────
  // Cloudways 스타일: 사이트 하나에 여러 도메인을 연결, 그중 하나를 Primary로 지정.
  // Alias는 Primary로 301 리다이렉트할 수도, 별도 호스트로 그대로 서빙할 수도 있음.

  const domainsListMatch = pathname.match(/^\/api\/sites\/([^/]+)\/domains$/);
  if (domainsListMatch && method === "GET") {
    const siteId = domainsListMatch[1];
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    const { results } = await env.DB.prepare(
      "SELECT * FROM site_domain_bindings WHERE site_id=? ORDER BY (role='primary') DESC, created_at ASC"
    ).bind(siteId).all();
    return json({ domains: results || [] });
  }

  if (domainsListMatch && method === "POST") {
    const siteId = domainsListMatch[1];
    const { hostname, zoneId, role, redirectToPrimary } = await request.json().catch(() => ({}));
    if (!hostname || !zoneId) return err("hostname과 zoneId가 필요합니다.");

    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    const dup = await env.DB.prepare(
      "SELECT id FROM site_domain_bindings WHERE hostname=?"
    ).bind(hostname).first();
    if (dup) return err("이미 등록된 도메인이에요.", 409);

    // 이 사이트에 기존 primary가 있는지 확인. 없으면 이번 등록을 primary로 강제.
    const existingPrimary = await env.DB.prepare(
      "SELECT id, hostname FROM site_domain_bindings WHERE site_id=? AND role='primary'"
    ).bind(siteId).first();
    const finalRole = existingPrimary ? (role === "primary" ? "alias" : (role || "alias")) : "primary";

    // 아직 프로비저닝되지 않은 사이트에 Primary 도메인을 처음 연결하는 경우:
    // 도메인을 먼저 정해야 프로비저닝이 시작되는 구조이므로, 여기서 바로 전체 프로비저닝을 트리거한다.
    // (Worker Route를 미리 걸 대상 워커 자체가 아직 없기 때문에, 따로 라우트만 거는 게 불가능함)
    if (finalRole === "primary" && !site.cf_worker_name) {
      const result = await provisionSite(env, userId, site, hostname, zoneId);
      return result; // provisionSite가 site_domain_bindings까지 함께 기록함
    }

    if (!site.cf_worker_name) return err("이 사이트는 아직 프로비저닝되지 않았어요. 먼저 Primary 도메인을 연결해주세요.", 400);

    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (!cred?.cf_global_api_key_enc) return err("Cloudflare API 키가 필요합니다.", 400);
    const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);

    const wantsRedirect = finalRole === "alias" && !!redirectToPrimary && !!existingPrimary;

    // CNAME 대상으로 쓸 workers.dev 호스트 확보 (실패해도 자기참조 CNAME으로 진행)
    let cnameTarget = null;
    let accountId = cred.cf_account_id;
    try {
      if (!accountId) accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
      const sub = await cf.getWorkerSubdomain(cred.cf_account_email, cfKey, accountId);
      cnameTarget = `${site.cf_worker_name}.${sub}.workers.dev`;
    } catch (_) {}

    let routeTarget = site.cf_worker_name;
    try {
      await cf.ensureProxiedRecord(cred.cf_account_email, cfKey, zoneId, hostname, cnameTarget);

      if (wantsRedirect) {
        // 별도의 경량 301 리다이렉트 워커를 배포하고, 그 워커로 라우트를 건다.
        if (!accountId) accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
        const redirectWorkerName = `${site.cf_worker_name}-redir-${hostname.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`.slice(0, 63);
        const redirectJs = buildRedirectWorkerJs(existingPrimary.hostname);
        await cf.deployModuleWorker(cred.cf_account_email, cfKey, accountId, redirectWorkerName, redirectJs);
        routeTarget = redirectWorkerName;
      }

      await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `${hostname}/*`, routeTarget);

      // 이번 등록이 Primary라면 pma.{hostname}도 함께 연결
      if (finalRole === "primary") {
        const pmaCnameTarget = cnameTarget ? `${site.cf_worker_name}-pma.${cnameTarget.split(".").slice(1).join(".")}` : null;
        await cf.ensureProxiedRecord(cred.cf_account_email, cfKey, zoneId, `pma.${hostname}`, pmaCnameTarget);
        await cf.addWorkerRoute(cred.cf_account_email, cfKey, zoneId, `pma.${hostname}/*`, `${site.cf_worker_name}-pma`).catch(() => {});
      }
    } catch (e) {
      return err(`Cloudflare 설정 실패: ${e.message}`, 500);
    }

    const bindingId = uid();
    await env.DB.prepare(
      `INSERT INTO site_domain_bindings (id,site_id,cf_zone_id,hostname,role,redirect_to_primary,status)
       VALUES (?,?,?,?,?,?,'active')`
    ).bind(bindingId, siteId, zoneId, hostname, finalRole, wantsRedirect ? 1 : 0).run();

    // primary로 지정된 경우 sites.custom_domain도 함께 갱신 (레거시 호환)
    if (finalRole === "primary") {
      await env.DB.prepare(
        "UPDATE sites SET custom_domain=?, cf_zone_id=?, updated_at=strftime('%s','now') WHERE id=?"
      ).bind(hostname, zoneId, siteId).run();
    }

    return json({ ok: true, id: bindingId, hostname, role: finalRole, redirecting: wantsRedirect });
  }

  const domainSetPrimaryMatch = pathname.match(/^\/api\/sites\/([^/]+)\/domains\/([^/]+)\/primary$/);
  if (domainSetPrimaryMatch && method === "PUT") {
    const [, siteId, bindingId] = domainSetPrimaryMatch;
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    const target = await env.DB.prepare(
      "SELECT * FROM site_domain_bindings WHERE id=? AND site_id=?"
    ).bind(bindingId, siteId).first();
    if (!target) return err("도메인을 찾을 수 없습니다.", 404);
    if (target.role === "primary") return json({ ok: true, alreadyPrimary: true });

    const oldPrimary = await env.DB.prepare(
      "SELECT * FROM site_domain_bindings WHERE site_id=? AND role='primary'"
    ).bind(siteId).first();

    // 새 Primary와 (강등될) 이전 Primary 둘 다 사이트 워커로 직접 라우팅되도록 정리
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (cred?.cf_global_api_key_enc && site.cf_worker_name) {
      const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
      for (const binding of [target, oldPrimary].filter(Boolean)) {
        try {
          const routes = await cf.listWorkerRoutes(cred.cf_account_email, cfKey, binding.cf_zone_id);
          const existingRoute = routes.find(r => r.pattern === `${binding.hostname}/*`);
          if (existingRoute) await cf.deleteWorkerRoute(cred.cf_account_email, cfKey, binding.cf_zone_id, existingRoute.id).catch(() => {});
          await cf.addWorkerRoute(cred.cf_account_email, cfKey, binding.cf_zone_id, `${binding.hostname}/*`, site.cf_worker_name);
        } catch (e) {
          console.error(`Route 재설정 실패 (${binding.hostname}):`, e.message);
        }
      }
    }

    // 기존 primary는 alias로 강등, 대상은 primary로 승격
    await env.DB.prepare(
      "UPDATE site_domain_bindings SET role='alias', redirect_to_primary=0 WHERE site_id=? AND role='primary'"
    ).bind(siteId).run();
    await env.DB.prepare(
      "UPDATE site_domain_bindings SET role='primary', redirect_to_primary=0 WHERE id=?"
    ).bind(bindingId).run();
    await env.DB.prepare(
      "UPDATE sites SET custom_domain=?, cf_zone_id=?, updated_at=strftime('%s','now') WHERE id=?"
    ).bind(target.hostname, target.cf_zone_id, siteId).run();

    return json({ ok: true, hostname: target.hostname });
  }

  const domainBindingMatch = pathname.match(/^\/api\/sites\/([^/]+)\/domains\/([^/]+)$/);
  if (domainBindingMatch && method === "PATCH") {
    const [, siteId, bindingId] = domainBindingMatch;
    const { redirectToPrimary } = await request.json().catch(() => ({}));
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    const target = await env.DB.prepare(
      "SELECT * FROM site_domain_bindings WHERE id=? AND site_id=?"
    ).bind(bindingId, siteId).first();
    if (!target) return err("도메인을 찾을 수 없습니다.", 404);
    if (target.role === "primary") return err("Primary 도메인은 리다이렉트 설정을 가질 수 없습니다.", 400);

    const primary = await env.DB.prepare(
      "SELECT hostname FROM site_domain_bindings WHERE site_id=? AND role='primary'"
    ).bind(siteId).first();
    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();

    if (cred?.cf_global_api_key_enc && primary && site.cf_worker_name) {
      const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
      try {
        const routes = await cf.listWorkerRoutes(cred.cf_account_email, cfKey, target.cf_zone_id);
        const existingRoute = routes.find(r => r.pattern === `${target.hostname}/*`);

        let newTarget = site.cf_worker_name;
        if (redirectToPrimary) {
          let accountId = cred.cf_account_id;
          if (!accountId) accountId = await cf.getAccountId(cred.cf_account_email, cfKey);
          const redirectWorkerName = `${site.cf_worker_name}-redir-${target.hostname.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`.slice(0, 63);
          await cf.deployModuleWorker(cred.cf_account_email, cfKey, accountId, redirectWorkerName, buildRedirectWorkerJs(primary.hostname));
          newTarget = redirectWorkerName;
        }

        if (existingRoute) {
          await cf.deleteWorkerRoute(cred.cf_account_email, cfKey, target.cf_zone_id, existingRoute.id).catch(() => {});
        }
        await cf.addWorkerRoute(cred.cf_account_email, cfKey, target.cf_zone_id, `${target.hostname}/*`, newTarget);
      } catch (e) {
        return err(`Cloudflare 라우트 갱신 실패: ${e.message}`, 500);
      }
    }

    await env.DB.prepare(
      "UPDATE site_domain_bindings SET redirect_to_primary=? WHERE id=?"
    ).bind(redirectToPrimary ? 1 : 0, bindingId).run();
    return json({ ok: true });
  }

  if (domainBindingMatch && method === "DELETE") {
    const [, siteId, bindingId] = domainBindingMatch;
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);
    const target = await env.DB.prepare(
      "SELECT * FROM site_domain_bindings WHERE id=? AND site_id=?"
    ).bind(bindingId, siteId).first();
    if (!target) return err("도메인을 찾을 수 없습니다.", 404);
    if (target.role === "primary") return err("Primary 도메인은 삭제할 수 없어요. 다른 도메인을 먼저 Primary로 지정해주세요.", 400);

    const cred = await env.DB.prepare(
      "SELECT * FROM user_credentials WHERE user_id=?"
    ).bind(userId).first();
    if (cred?.cf_global_api_key_enc) {
      const cfKey = await decryptSecret(env, cred.cf_global_api_key_enc);
      try {
        const routes = await cf.listWorkerRoutes(cred.cf_account_email, cfKey, target.cf_zone_id);
        const match = routes.find(r => r.pattern === `${target.hostname}/*`);
        if (match) await cf.deleteWorkerRoute(cred.cf_account_email, cfKey, target.cf_zone_id, match.id).catch(() => {});
      } catch (e) {
        console.error("Route 삭제 실패:", e.message);
      }
    }

    await env.DB.prepare("DELETE FROM site_domain_bindings WHERE id=?").bind(bindingId).run();
    return json({ ok: true });
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

    const pmaPass = (row.pma_password_plain_enc || row.pla_password_plain_enc)
      ? await decryptSecret(env, row.pma_password_plain_enc || row.pla_password_plain_enc)
      : null;
    const wpPass = row.wp_admin_password_plain_enc
      ? await decryptSecret(env, row.wp_admin_password_plain_enc)
      : null;

    // phpMyAdmin 임시 토큰 발급/조회
    const now = Math.floor(Date.now() / 1000);
    let pmaToken = await env.DB.prepare(
      "SELECT token FROM pma_tokens WHERE site_id=? AND expires_at>?"
    ).bind(siteId, now).first();
    if (!pmaToken) {
      const newToken = randomToken();
      await env.DB.prepare(
        "INSERT INTO pma_tokens (id,site_id,token,expires_at) VALUES (?,?,?,?)"
      ).bind(uid(), siteId, newToken, kstMidnightTimestamp()).run();
      pmaToken = { token: newToken };
    }

    const customDomain = site.custom_domain;
    const pmaUrl   = customDomain ? `https://pma.${customDomain}` : (site.tunnel_pla_url || null);
    const adminUrl = customDomain
      ? `https://${customDomain}/wp-admin`
      : (site.cf_worker_url ? `${site.cf_worker_url}/wp-admin` : null);

    return json({
      provisioned: true,
      pma: {
        url:         pmaUrl,
        fallbackUrl: `/phpmyadmin-lite.html?token=${pmaToken.token}`,
        username:    row.pma_username || row.pla_username || "admin",
        password:    pmaPass,
        dbHost:      row.db_host || "127.0.0.1",
        dbPort:      row.db_port || "3306",
        dbName:      row.db_name || "wordpress",
        dbUser:      row.db_username || "wpuser",
        dbPath:      row.db_path || "wordpress@127.0.0.1:3306",
        engine:      row.db_engine || "MariaDB/MySQL",
      },
      pla: {
        url:         pmaUrl,
        fallbackUrl: `/phpmyadmin-lite.html?token=${pmaToken.token}`,
        username:    row.pma_username || row.pla_username || "admin",
        password:    pmaPass,
        dbPath:      row.db_path || "wordpress@127.0.0.1:3306",
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
      redis: {
        enabled: !!row.redis_enabled,
        provider: row.redis_enabled ? (row.redis_provider || "Redis 7 (로컬)") : null,
      },
      domain: {
        customDomain: site.custom_domain,
        pmaDomain:    customDomain ? `pma.${customDomain}` : null,
        tunnelWpUrl:  site.cf_worker_url,
        tunnelPlaUrl: site.tunnel_pla_url,
      },
    });
  }

  const credUpdateMatch = pathname.match(/^\/api\/sites\/([^/]+)\/credentials$/);
  if (credUpdateMatch && method === "PUT") {
    const siteId = credUpdateMatch[1];
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id=? AND user_id=?"
    ).bind(siteId, userId).first();
    if (!site) return err("사이트를 찾을 수 없습니다.", 404);

    const body = await request.json().catch(() => ({}));
    const sets = [];
    const binds = [];

    const wpUsername = String(body.wpUsername || "").trim();
    const wpPassword = String(body.wpPassword || "");
    const pmaUsername = String(body.pmaUsername || "").trim();
    const pmaPassword = String(body.pmaPassword || "");

    if (wpUsername) { sets.push("wp_admin_username=?"); binds.push(wpUsername); }
    if (wpPassword) { sets.push("wp_admin_password_plain_enc=?"); binds.push(await encryptSecret(env, wpPassword)); }
    if (pmaUsername) {
      sets.push("pma_username=?", "pla_username=?");
      binds.push(pmaUsername, pmaUsername);
    }
    if (pmaPassword) {
      const pmaHash = await hashPassword(pmaPassword);
      const pmaEnc = await encryptSecret(env, pmaPassword);
      sets.push("pma_password_hash=?", "pma_password_plain_enc=?", "pla_password_hash=?", "pla_password_plain_enc=?");
      binds.push(pmaHash, pmaEnc, pmaHash, pmaEnc);
    }

    if (!sets.length) return err("변경할 관리자 정보를 입력해주세요.");

    const existing = await env.DB.prepare("SELECT site_id FROM site_credentials WHERE site_id=?").bind(siteId).first();
    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO site_credentials
         (site_id,pma_username,pla_username,pma_password_hash,pla_password_hash,db_path,db_engine,db_host,db_port,db_name,db_username,nginx_status)
         VALUES (?, 'admin', 'admin', '', '', 'wordpress@127.0.0.1:3306', 'MariaDB/MySQL', '127.0.0.1', '3306', 'wordpress', 'wpuser', 'not_provisioned')`
      ).bind(siteId).run();
    }

    await env.DB.prepare(`UPDATE site_credentials SET ${sets.join(",")} WHERE site_id=?`).bind(...binds, siteId).run();
    await env.DB.prepare("DELETE FROM pma_tokens WHERE site_id=?").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM pla_tokens WHERE site_id=?").bind(siteId).run().catch(() => {});
    return json({ ok: true, message: "관리자 정보가 업데이트됐어요." });
  }

  // ── phpMyAdmin Lite 데이터 (D1 호환 뷰, 실 DB는 MariaDB/MySQL) ─────────────

  if ((pathname === "/api/pma/tables" || pathname === "/api/pla/tables") && method === "GET") {
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

  if ((pathname === "/api/pma/update" || pathname === "/api/pla/update") && method === "POST") {
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

  if ((pathname === "/api/pma/delete" || pathname === "/api/pla/delete") && method === "POST") {
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
