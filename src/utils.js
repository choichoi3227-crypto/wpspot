// src/utils.js
// 유틸리티: 한글/영어 slug 변환, WP 스키마 초기화

// 한글, 영어, 숫자를 포함한 사이트 이름을 URL 안전 slug로 변환
// 한글 → 로마자 음역 or 유니코드 code point hex
export function slugify(name) {
  let s = name.trim().toLowerCase();

  // 한글 → 로마자 간이 매핑 (초성 기준)
  const hangulMap = {
    가: "ga", 나: "na", 다: "da", 라: "ra", 마: "ma", 바: "ba", 사: "sa",
    아: "a", 자: "ja", 차: "cha", 카: "ka", 타: "ta", 파: "pa", 하: "ha",
    각: "gak", 낙: "nak", 박: "bak", 삭: "sak", 악: "ak", 작: "jak",
    강: "gang", 낭: "nang", 당: "dang", 망: "mang", 방: "bang", 상: "sang",
    앙: "ang", 장: "jang", 창: "chang", 항: "hang",
    개: "gae", 내: "nae", 대: "dae", 래: "rae", 매: "mae", 배: "bae",
    새: "sae", 애: "ae", 재: "jae", 채: "chae", 해: "hae",
    고: "go", 노: "no", 도: "do", 로: "ro", 모: "mo", 보: "bo", 소: "so",
    오: "o", 조: "jo", 초: "cho", 코: "ko", 토: "to", 포: "po", 호: "ho",
    구: "gu", 누: "nu", 두: "du", 루: "ru", 무: "mu", 부: "bu", 수: "su",
    우: "u", 주: "ju", 추: "chu", 쿠: "ku", 투: "tu", 후: "hu",
    기: "gi", 니: "ni", 디: "di", 리: "ri", 미: "mi", 비: "bi", 시: "si",
    이: "i", 지: "ji", 치: "chi", 키: "ki", 티: "ti", 피: "pi", 히: "hi",
    글: "geul", 블: "beul", 들: "deul", 를: "reul", 을: "eul",
    블로그: "blog", 뉴스: "news", 생활: "life", 일상: "daily",
    여행: "travel", 음식: "food", 기술: "tech", 패션: "fashion",
    사진: "photo", 영화: "movie", 음악: "music", 스포츠: "sports",
    건강: "health", 문화: "culture", 교육: "edu", 경제: "economy",
    사이트: "site", 블로그: "blog", 웹사이트: "website", 홈페이지: "homepage",
    나의: "my", 내: "my", 우리: "our",
  };

  // 단어 단위 매핑 먼저 시도
  for (const [kor, eng] of Object.entries(hangulMap)) {
    s = s.replace(new RegExp(kor, "g"), eng);
  }

  // 남은 한글 → 유니코드 codepoint hex
  s = s.replace(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g, (c) => {
    return c.codePointAt(0).toString(16);
  });

  // 특수문자 제거, 공백/밑줄 → 하이픈
  s = s.replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, ""); // 앞뒤 하이픈 제거

  // 최소 3자, 최대 50자
  if (s.length < 3) s = s.padEnd(3, "0");
  return s.slice(0, 50);
}

// WordPress 기본 스키마 데이터 초기화
export async function initWpSchema(DB, siteId, siteName, siteUrl, blogUrl) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  // wp_options 기본값 삽입
  const defaultOptions = [
    ["siteurl", siteUrl || ""],
    ["blogname", siteName],
    ["blogdescription", ""],
    ["admin_email", ""],
    ["blogurl", blogUrl || ""],
    ["template", "default"],
    ["stylesheet", "default"],
    ["posts_per_page", "10"],
    ["date_format", "Y년 n월 j일"],
    ["time_format", "g:i a"],
    ["permalink_structure", "/%year%/%monthnum%/%postname%/"],
    ["timezone_string", "Asia/Seoul"],
    ["WPLANG", "ko_KR"],
    ["active_plugins", "a:1:{i:0;s:45:\"sqlite-database-integration/load.php\";}"],
    ["wpspot_version", "1.0.0"],
    ["wpspot_storage", JSON.stringify({
      posts: "blogspot+github",
      pages: "blogspot+github",
      media: "github",
      options: "internal_db",
      users: "internal_db",
    })],
  ];

  for (const [name, value] of defaultOptions) {
    await DB.prepare(
      "INSERT INTO wp_options (site_id, option_name, option_value) VALUES (?, ?, ?) ON CONFLICT(site_id, option_name) DO NOTHING"
    ).bind(siteId, name, value).run().catch(() => {});
  }

  // wp_users 기본 관리자
  const existing = await DB.prepare("SELECT ID FROM wp_users WHERE site_id = ? LIMIT 1").bind(siteId).first().catch(() => null);
  if (!existing) {
    await DB.prepare(
      `INSERT INTO wp_users
       (site_id, user_login, user_pass, user_nicename, user_email, user_registered, display_name)
       VALUES (?, 'admin', '', 'admin', '', ?, '관리자')`
    ).bind(siteId, now).run().catch(() => {});
  }
}
