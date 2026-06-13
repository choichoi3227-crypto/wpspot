// public/js/app.js
// wpspot 공통 클라이언트 로직: API 호출 헬퍼, 토큰 저장, 토스트, 가드.

const wpspot = (() => {
  const TOKEN_KEY = "wpspot_token";
  const USER_KEY = "wpspot_user";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function requireAuth() {
    if (!getToken()) {
      window.location.href = "/login.html";
      return false;
    }
    return true;
  }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(path, { ...options, headers });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 401) {
      clearSession();
      window.location.href = "/login.html";
      throw new Error("로그인이 필요합니다.");
    }

    if (!res.ok) {
      const message = (data && data.error) || `요청에 실패했어요 (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  function toast(message, duration = 2400) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  function statusBadge(status) {
    const map = {
      active: ["badge--active", "운영 중"],
      pending: ["badge--pending", "대기"],
      provisioning: ["badge--provisioning", "구성 중"],
      error: ["badge--error", "오류"],
    };
    const [cls, label] = map[status] || map.pending;
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  return { getToken, setSession, getUser, clearSession, requireAuth, api, toast, statusBadge, escapeHtml };
})();

