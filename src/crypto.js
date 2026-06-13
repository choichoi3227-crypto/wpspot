// src/crypto.js
// 사용자가 입력한 GitHub Token, GCP Blogger OAuth Token, Cloudflare Global API Key를
// D1에 평문으로 저장하지 않기 위한 AES-256-GCM 암복호화 유틸리티.
// 마스터 키는 wrangler secret(CRED_ENC_KEY)으로 주입되며 base64 32바이트 문자열이어야 한다.

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function getKey(env) {
  if (!env.CRED_ENC_KEY) {
    throw new Error("CRED_ENC_KEY secret이 설정되지 않았습니다. `wrangler secret put CRED_ENC_KEY`로 32바이트(base64) 키를 등록하세요.");
  }
  const raw = base64ToBytes(env.CRED_ENC_KEY);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// 평문 -> "ivBase64:cipherBase64" 형태의 문자열
export async function encryptSecret(env, plaintext) {
  if (plaintext == null || plaintext === "") return null;
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuf))}`;
}

// "ivBase64:cipherBase64" -> 평문
export async function decryptSecret(env, stored) {
  if (!stored) return null;
  const [ivB64, dataB64] = stored.split(":");
  const key = await getKey(env);
  const iv = base64ToBytes(ivB64);
  const data = base64ToBytes(dataB64);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plainBuf);
}
