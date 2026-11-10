// Business roles (openspec: role-system; ADR-0028) — the enumeration only.
//
// The slug set is shared contract: layout presets, onboarding recipes, the
// role editor and the i18n bundles all key on these strings, on both sides of
// the wire. It lives in core for that reason; the server module (server/roles.js)
// re-exports it and adds the server-only machinery (storage, admission groups,
// header parsing).
//
// The enumeration is closed and stable — slugs are public API in the same
// sense settings-section slugs are. Adding a role is a deliberate act.

export const BUSINESS_ROLES = [
  "legal", // 法律人员
  "economic", // 经济分析
  "financial", // 金融分析
  "stock", // 股票分析
  "screenplay", // 剧本创作
  "paper", // 论文写作
  "technical", // 技术用户
  "standard", // 标准用户 — the fallback for everyone unassigned
];

export const DEFAULT_ROLE = "standard";

export function isBusinessRole(slug: unknown): slug is string {
  return typeof slug === "string" && (BUSINESS_ROLES as readonly string[]).includes(slug);
}
