// public/js/app.js — wpspot 공통 클라이언트

const wpspot = (() => {
  const TOKEN_KEY = "wpspot_token";
  const USER_KEY  = "wpspot_user";

  function getToken()  { return localStorage.getItem(TOKEN_KEY); }
  function getUser()   {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
    catch { return null; }
  }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function requireAuth() {
    if (!getToken()) { window.location.href = "/login.html"; return false; }
    return true;
  }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401) {
      clearSession();
      window.location.href = "/login.html";
      throw new Error("로그인이 필요합니다.");
    }
    if (!res.ok) throw new Error((data && data.error) || `요청 실패 (${res.status})`);
    return data;
  }

  // ── 토스트 알림 ──────────────────────────────────────────────────────────
  let toastQueue = [];
  let toastShowing = false;

  function toast(message, type = "info", duration = 3000) {
    toastQueue.push({ message, type, duration });
    if (!toastShowing) showNextToast();
  }

  function showNextToast() {
    if (!toastQueue.length) { toastShowing = false; return; }
    toastShowing = true;
    const { message, type, duration } = toastQueue.shift();

    // 기존 toast 제거
    document.querySelectorAll(".toast-wpspot").forEach(el => el.remove());

    const el = document.createElement("div");
    el.className = "toast-wpspot";
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "polite");

    const icon = type === "error" ? "✕" : type === "success" ? "✓" : "ℹ";
    el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escapeHtml(message)}</span>`;

    Object.assign(el.style, {
      position:     "fixed",
      bottom:       "24px",
      left:         "50%",
      transform:    "translateX(-50%) translateY(20px)",
      background:   type === "error" ? "#dc2626" : type === "success" ? "#059669" : "#1e293b",
      color:        "#fff",
      padding:      "10px 18px",
      borderRadius: "10px",
      fontSize:     "14px",
      fontWeight:   "500",
      boxShadow:    "0 4px 20px rgba(0,0,0,.25)",
      zIndex:       "9999",
      display:      "flex",
      alignItems:   "center",
      gap:          "8px",
      maxWidth:     "90vw",
      opacity:      "0",
      transition:   "opacity 200ms ease, transform 200ms ease",
    });

    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";
    });

    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(10px)";
      setTimeout(() => {
        el.remove();
        setTimeout(showNextToast, 200);
      }, 200);
    }, duration);
  }

  // ── 상태 배지 ────────────────────────────────────────────────────────────
  function statusBadge(status) {
    const map = {
      active:       ["#d1fae5", "#065f46", "● 운영 중"],
      pending:      ["#fef3c7", "#92400e", "○ 대기"],
      provisioning: ["#dbeafe", "#1d4ed8", "◌ 구성 중"],
      error:        ["#fee2e2", "#991b1b", "✕ 오류"],
    };
    const [bg, color, label] = map[status] || map.pending;
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;
      font-weight:600;padding:3px 10px;border-radius:999px;
      background:${bg};color:${color};">${label}</span>`;
  }

  // ── HTML 이스케이프 ──────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])
    );
  }

  // ── 사이드바 / 탑 헤더 셀 렌더링 (Cloudways 스타일 SaaS 레이아웃) ──────────
  const NAV_ITEMS = [
    { key: "dashboard", href: "/dashboard.html",    icon: "layout-grid", label: "대시보드" },
    { key: "domains",   href: "/domains.html",      icon: "globe",       label: "도메인" },
    { key: "account",   href: "/account.html",      icon: "user",        label: "내 계정" },
  ];

  const ICONS = {
    "layout-grid": '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    "globe": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/>',
    "user": '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-7 8-7s8 3 8 7"/>',
    "server": '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="0.8" fill="currentColor"/><circle cx="7" cy="17" r="0.8" fill="currentColor"/>',
    "menu": '<path d="M3 6h18M3 12h18M3 18h18"/>',
    "logout": '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  };

  function icon(name, size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
  }

  // 페이지 <body> 최상단에 사이드바+탑바를 주입하고 .app-shell을 컨텐츠 영역으로 감싼다.
  // 호출: 각 페이지 스크립트 맨 위에서 wpspot.renderShell('dashboard', '대시보드') 호출.
  function renderShell(activeKey, pageTitle) {
    if (document.querySelector(".wps-sidebar")) return; // 중복 방지

    const user = getUser();
    const initials = (user?.displayName || user?.email || "?").trim().slice(0, 1).toUpperCase();

    const navHtml = NAV_ITEMS.map(item => `
      <a class="wps-nav__item ${item.key === activeKey ? 'wps-nav__item--active' : ''}" href="${item.href}">
        ${icon(item.icon)}<span>${item.label}</span>
      </a>
    `).join("");

    const sidebar = document.createElement("aside");
    sidebar.className = "wps-sidebar";
    sidebar.innerHTML = `
      <div class="wps-sidebar__brand">
        <span class="wps-sidebar__logo">${icon("server", 20)}</span>
        <span class="wps-sidebar__name">wpspot</span>
      </div>
      <nav class="wps-nav">${navHtml}</nav>
      <div class="wps-sidebar__footer">
        <button class="wps-nav__item wps-nav__item--logout" id="wpsLogoutBtn">
          ${icon("logout")}<span>로그아웃</span>
        </button>
      </div>
    `;

    const scrim = document.createElement("div");
    scrim.className = "wps-drawer-scrim";

    const topbar = document.createElement("div");
    topbar.className = "wps-topbar";
    topbar.innerHTML = `
      <button class="wps-topbar__menu" id="wpsMenuBtn" aria-label="메뉴 열기">${icon("menu")}</button>
      <span class="wps-topbar__title">${pageTitle || ""}</span>
      <div class="wps-topbar__spacer"></div>
      <div class="wps-topbar__avatar" title="${escapeHtml(user?.email || "")}">${escapeHtml(initials)}</div>
    `;

    document.body.classList.add("wps-has-shell");
    document.body.insertBefore(scrim, document.body.firstChild);
    document.body.insertBefore(sidebar, document.body.firstChild);

    const main = document.createElement("div");
    main.className = "wps-main";
    const shell = document.querySelector(".app-shell");
    if (shell) {
      shell.parentNode.insertBefore(main, shell);
      main.appendChild(topbar);
      main.appendChild(shell);
      shell.classList.add("wps-content");
    }

    document.getElementById("wpsLogoutBtn")?.addEventListener("click", () => {
      clearSession();
      window.location.href = "/login.html";
    });
    document.getElementById("wpsMenuBtn")?.addEventListener("click", () => {
      document.body.classList.toggle("wps-drawer-open");
    });
    scrim.addEventListener("click", () => document.body.classList.remove("wps-drawer-open"));
  }

  // ── 클립보드 복사 ────────────────────────────────────────────────────────
  function copyText(val) {
    if (!val) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(val).catch(() => fallbackCopy(val));
    } else {
      fallbackCopy(val);
    }
  }

  function fallbackCopy(val) {
    const ta = document.createElement("textarea");
    ta.value = val;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  // ── 날짜 포맷 ────────────────────────────────────────────────────────────
  function formatDate(unixTs) {
    if (!unixTs) return "—";
    return new Date(unixTs * 1000).toLocaleString("ko-KR", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  }

  return {
    getToken, getUser, setSession, clearSession, requireAuth,
    api, toast, statusBadge, escapeHtml, copyText, formatDate, renderShell,
  };
})();
