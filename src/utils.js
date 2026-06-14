// src/utils.js
// 유틸리티: 한글/영어 slug 변환, WP 스키마 초기화

// 한글, 영어, 숫자를 포함한 사이트 이름을 URL 안전 slug로 변환
export function slugify(name) {
  let s = name.trim().toLowerCase();

  // 한글 단어 → 영어 매핑 (긴 것부터 먼저 치환)
  const hangulMap = [
    ["블로그", "blog"],
    ["웹사이트", "website"],
    ["홈페이지", "homepage"],
    ["사이트", "site"],
    ["뉴스", "news"],
    ["생활", "life"],
    ["일상", "daily"],
    ["여행", "travel"],
    ["음식", "food"],
    ["기술", "tech"],
    ["패션", "fashion"],
    ["사진", "photo"],
    ["영화", "movie"],
    ["음악", "music"],
    ["스포츠", "sports"],
    ["건강", "health"],
    ["문화", "culture"],
    ["교육", "edu"],
    ["경제", "economy"],
    ["나의", "my"],
    ["우리", "our"],
    // 단음절
    ["가", "ga"], ["나", "na"], ["다", "da"], ["라", "ra"],
    ["마", "ma"], ["바", "ba"], ["사", "sa"], ["아", "a"],
    ["자", "ja"], ["차", "cha"], ["카", "ka"], ["타", "ta"],
    ["파", "pa"], ["하", "ha"],
    ["각", "gak"], ["낙", "nak"], ["박", "bak"], ["삭", "sak"],
    ["악", "ak"], ["작", "jak"],
    ["강", "gang"], ["낭", "nang"], ["당", "dang"], ["망", "mang"],
    ["방", "bang"], ["상", "sang"], ["앙", "ang"], ["장", "jang"],
    ["창", "chang"], ["항", "hang"],
    ["개", "gae"], ["내", "nae"], ["대", "dae"], ["래", "rae"],
    ["매", "mae"], ["배", "bae"], ["새", "sae"], ["애", "ae"],
    ["재", "jae"], ["채", "chae"], ["해", "hae"],
    ["고", "go"], ["노", "no"], ["도", "do"], ["로", "ro"],
    ["모", "mo"], ["보", "bo"], ["소", "so"], ["오", "o"],
    ["조", "jo"], ["초", "cho"], ["코", "ko"], ["토", "to"],
    ["포", "po"], ["호", "ho"],
    ["구", "gu"], ["누", "nu"], ["두", "du"], ["루", "ru"],
    ["무", "mu"], ["부", "bu"], ["수", "su"], ["우", "u"],
    ["주", "ju"], ["추", "chu"], ["쿠", "ku"], ["투", "tu"],
    ["후", "hu"],
    ["기", "gi"], ["니", "ni"], ["디", "di"], ["리", "ri"],
    ["미", "mi"], ["비", "bi"], ["시", "si"], ["이", "i"],
    ["지", "ji"], ["치", "chi"], ["키", "ki"], ["티", "ti"],
    ["피", "pi"], ["히", "hi"],
    ["글", "geul"], ["블", "beul"], ["들", "deul"], ["를", "reul"],
    ["을", "eul"],
    ["내", "nae"],
  ];

  for (const [kor, eng] of hangulMap) {
    s = s.split(kor).join(eng);
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

  // wp_options 기본값 삽입 (UPSERT: 이미 있으면 덮어쓰기)
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
    // WordPress 필수 옵션들
    ["default_comment_status", "open"],
    ["default_ping_status", "open"],
    ["blogpublic", "1"],
    ["default_category", "1"],
    ["show_on_front", "posts"],
    ["upload_path", ""],
    ["upload_url_path", ""],
  ];

  for (const [name, value] of defaultOptions) {
    await DB.prepare(
      `INSERT INTO wp_options (site_id, option_name, option_value)
       VALUES (?, ?, ?)
       ON CONFLICT(site_id, option_name) DO UPDATE SET option_value = excluded.option_value`
    ).bind(siteId, name, value).run().catch((e) => {
      console.error(`wp_options insert 실패 (${name}):`, e.message);
    });
  }

  // wp_users 기본 관리자 삽입 (없을 때만)
  const existingUser = await DB.prepare(
    "SELECT ID FROM wp_users WHERE site_id = ? LIMIT 1"
  ).bind(siteId).first().catch(() => null);

  let adminUserId = existingUser?.ID;

  if (!existingUser) {
    const insertResult = await DB.prepare(
      `INSERT INTO wp_users
       (site_id, user_login, user_pass, user_nicename, user_email,
        user_url, user_registered, display_name, user_status)
       VALUES (?, 'admin', '', 'admin', '', ?, ?, '관리자', 0)`
    ).bind(siteId, siteUrl || "", now).run().catch((e) => {
      console.error("wp_users insert 실패:", e.message);
      return null;
    });

    // 삽입된 admin의 ID 조회
    if (insertResult) {
      const newUser = await DB.prepare(
        "SELECT ID FROM wp_users WHERE site_id = ? AND user_login = 'admin' LIMIT 1"
      ).bind(siteId).first().catch(() => null);
      adminUserId = newUser?.ID;
    }
  }

  // wp_usermeta: admin 역할 및 기본 메타 삽입
  if (adminUserId) {
    const userMetas = [
      [adminUserId, "wp_capabilities", 'a:1:{s:13:"administrator";b:1;}'],
      [adminUserId, "wp_user_level", "10"],
      [adminUserId, "nickname", "admin"],
      [adminUserId, "description", ""],
      [adminUserId, "rich_editing", "true"],
      [adminUserId, "comment_shortcuts", "false"],
      [adminUserId, "admin_color", "fresh"],
      [adminUserId, "use_ssl", "0"],
      [adminUserId, "show_admin_bar_front", "true"],
      [adminUserId, "wp_dashboard_quick_press_last_post_id", "0"],
    ];

    for (const [userId, metaKey, metaValue] of userMetas) {
      // 이미 있으면 건너뜀
      const existing = await DB.prepare(
        "SELECT umeta_id FROM wp_usermeta WHERE site_id = ? AND user_id = ? AND meta_key = ? LIMIT 1"
      ).bind(siteId, userId, metaKey).first().catch(() => null);

      if (!existing) {
        await DB.prepare(
          "INSERT INTO wp_usermeta (site_id, user_id, meta_key, meta_value) VALUES (?, ?, ?, ?)"
        ).bind(siteId, userId, metaKey, metaValue).run().catch((e) => {
          console.error(`wp_usermeta insert 실패 (${metaKey}):`, e.message);
        });
      }
    }
  }

  // wp_terms: 기본 카테고리 삽입
  const existingTerm = await DB.prepare(
    "SELECT term_id FROM wp_terms WHERE site_id = ? LIMIT 1"
  ).bind(siteId).first().catch(() => null);

  let defaultTermId = existingTerm?.term_id;

  if (!existingTerm) {
    await DB.prepare(
      "INSERT INTO wp_terms (site_id, name, slug, term_group) VALUES (?, '미분류', 'uncategorized', 0)"
    ).bind(siteId).run().catch((e) => {
      console.error("wp_terms insert 실패:", e.message);
    });

    const newTerm = await DB.prepare(
      "SELECT term_id FROM wp_terms WHERE site_id = ? AND slug = 'uncategorized' LIMIT 1"
    ).bind(siteId).first().catch(() => null);
    defaultTermId = newTerm?.term_id;
  }

  // wp_term_taxonomy: 기본 카테고리 taxonomy
  if (defaultTermId) {
    const existingTax = await DB.prepare(
      "SELECT term_taxonomy_id FROM wp_term_taxonomy WHERE site_id = ? AND term_id = ? LIMIT 1"
    ).bind(siteId, defaultTermId).first().catch(() => null);

    if (!existingTax) {
      await DB.prepare(
        `INSERT INTO wp_term_taxonomy (site_id, term_id, taxonomy, description, parent, count)
         VALUES (?, ?, 'category', '', 0, 0)`
      ).bind(siteId, defaultTermId).run().catch((e) => {
        console.error("wp_term_taxonomy insert 실패:", e.message);
      });
    }
  }
}

