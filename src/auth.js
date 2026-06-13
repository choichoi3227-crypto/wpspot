// src/auth.js
// 외부 의존성 없는 경량 JWT(HS256) + 비밀번호 해시(PBKDF2) 구현.
// Cloudflare Workers의 Web Crypto API만 사용한다.

function base64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// JWT 발급 (exp는 초 단위 unix timestamp)
export async function signJWT(payload, secret, expiresInSeconds = 60 * 60 * 24 * 7) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const encHeader = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64urlEncode(new TextEncoder().encode(JSON.stringify(fullPayload)));
  const data = `${encHeader}.${encPayload}`;

  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const encSig = base64urlEncode(new Uint8Array(sig));

  return `${data}.${encSig}`;
}

// JWT 검증. 유효하면 payload 반환, 아니면 null
export async function verifyJWT(token, secret) {
  try {
    const [encHeader, encPayload, encSig] = token.split(".");
    if (!encHeader || !encPayload || !encSig) return null;

    const key = await hmacKey(secret);
    const data = `${encHeader}.${encPayload}`;
    const sig = base64urlDecode(encSig);
    const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(encPayload)));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// 비밀번호 해시 (PBKDF2-SHA256, 100,000 iterations)
// 저장 형식: "iterations:saltBase64:hashBase64"
export async function hashPassword(password) {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${iterations}:${base64urlEncode(salt)}:${base64urlEncode(new Uint8Array(derived))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [iterStr, saltB64, hashB64] = stored.split(":");
    const iterations = parseInt(iterStr, 10);
    const salt = base64urlDecode(saltB64);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      256
    );
    const derivedB64 = base64urlEncode(new Uint8Array(derived));
    return derivedB64 === hashB64;
  } catch (e) {
    return false;
  }
}

// Authorization: Bearer <token> 헤더에서 사용자 정보를 추출
export async function getUserFromRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const payload = await verifyJWT(match[1], env.JWT_SECRET);
  if (!payload || !payload.sub) return null;
  return payload; // { sub: userId, email }
}
