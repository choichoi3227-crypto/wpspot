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
    api, toast, statusBadge, escapeHtml, copyText, formatDate,
  };
})();
