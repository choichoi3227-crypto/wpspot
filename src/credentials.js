// src/credentials.js
// 호스팅 상세에서 노출되는 phpMyAdmin-lite 계정(유저네임/비밀번호)을
// 보안성 있게 랜덤 생성한다.

const ADJ = ["amber", "azure", "coral", "ember", "ivory", "jade", "lotus", "maple", "onyx", "pearl", "quartz", "raven", "sable", "topaz", "violet", "willow"];
const NOUN = ["falcon", "harbor", "meadow", "nimbus", "orbit", "prairie", "ridge", "summit", "tundra", "vector", "wren", "zephyr"];

function randomFrom(arr) {
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

function randomDigits(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// 사람이 읽기 쉬운 유저네임: wp_<adj><noun><4digits>
export function generateUsername() {
  return `wp_${randomFrom(ADJ)}${randomFrom(NOUN)}${randomDigits(4)}`;
}

// 충분히 강력한 랜덤 비밀번호 (영문 대소문자+숫자+특수문자, 20자)
export function generatePassword(length = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}
