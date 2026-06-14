// src/utils.js

// 한글/영어/숫자 → URL 안전 slug
export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[가-힣]/g, "") // 한글 제거 (영어권 slug용)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "site-" + Date.now().toString(36);
}

// WordPress 기본 옵션 초기화 (D1 wp_options 테이블)
export async function initWpOptions(DB, siteId, siteName, siteUrl) {
  const defaults = [
    ["siteurl", siteUrl || ""],
    ["home", siteUrl || ""],
    ["blogname", siteName],
    ["blogdescription", ""],
    ["admin_email", ""],
    ["template", "twentytwentyfour"],
    ["stylesheet", "twentytwentyfour"],
    ["posts_per_page", "10"],
    ["permalink_structure", "/%postname%/"],
    ["upload_path", "wp-content/uploads"],
    ["active_plugins", ""],
  ];
  for (const [k, v] of defaults) {
    await DB.prepare(
      "INSERT INTO wp_options (site_id, option_name, option_value) VALUES (?, ?, ?) ON CONFLICT(site_id, option_name) DO NOTHING"
    ).bind(siteId, k, v).run();
  }
}
