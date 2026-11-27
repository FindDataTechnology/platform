// ── Personal domain map (widen-deputy-to-personal-domains 1.1-1.3) ──────────
//
// Which event source lands in which mandate domain. Deliberately data, not
// code: the owner can turn a source off without a release, and the fact that
// nothing is enabled by default is what makes this change a no-op on upgrade.
//
// It does NOT decide how far the agent may act — that is the mandate's mode.
// A source mapping only answers "does this item enter a domain at all".
//
// Leaf module: imports nothing, so both the resolver path and the DB layer can
// use it without a cycle.

export const SOURCES = Object.freeze([
  "cross-line-blocker", // 跨线阻塞与依赖
  "supplier-thread", // 供应商/合作方答复口径
  "people-schedule", // 人事与排期冲突
]);

// The starting mapping. `enabled: false` everywhere: an upgrade must not start
// routing personal matters anywhere until the owner says so.
export const DEFAULT_DOMAIN_MAP = Object.freeze([
  Object.freeze({ source: "cross-line-blocker", domain: "ops", enabled: false }),
  Object.freeze({ source: "supplier-thread", domain: "external-comms", enabled: false }),
  Object.freeze({ source: "people-schedule", domain: "advancement", enabled: false }),
]);

// Kept local to avoid importing personal-mandate (which would be fine, but this
// module is also imported by DB init paths that must stay dependency-thin).
const DOMAINS = Object.freeze(["ops", "external-comms", "advancement", "research"]);

function isDomain(name) {
  return DOMAINS.includes(name);
}

function isSource(name) {
  return SOURCES.includes(name);
}

/**
 * Normalize a stored map.
 *
 * Rejections are deliberate: an unknown source is a typo that would silently
 * never fire, and an unknown domain is a typo that would silently route items
 * nowhere. Both look identical to "nothing happened", which is the worst
 * failure mode for a routing table.
 *
 * Returns { ok: true, map } with the full three-entry shape (missing entries
 * filled from DEFAULT, disabled), or { ok: false, error }.
 */
export function normalizeDomainMap(raw) {
  const bySource = new Map(DEFAULT_DOMAIN_MAP.map((e) => [e.source, { ...e }]));
  if (raw === null || raw === undefined) {
    return { ok: true, map: [...bySource.values()] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "domain map must be an array" };
  }

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "domain map entries must be objects" };
    }
    if (!isSource(entry.source)) {
      return { ok: false, error: `unknown domain-map source: ${entry.source}` };
    }
    if (entry.domain !== undefined && !isDomain(entry.domain)) {
      return { ok: false, error: `unknown domain in map: ${entry.domain}` };
    }
    const current = bySource.get(entry.source);
    bySource.set(entry.source, {
      source: entry.source,
      // A source may be re-pointed, but never to a non-existent domain.
      domain: entry.domain ?? current.domain,
      enabled: entry.enabled === true,
    });
  }

  return { ok: true, map: [...bySource.values()] };
}

/**
 * The domain a source routes into, or null when it is unknown or switched off.
 * Callers treat null as "no domain" — the item then follows the pre-existing
 * behaviour untouched.
 */
export function domainFor(map, source) {
  if (!isSource(source)) return null;
  const entries = Array.isArray(map) ? map : DEFAULT_DOMAIN_MAP;
  const entry = entries.find((e) => e.source === source);
  if (!entry || entry.enabled !== true) return null;
  return isDomain(entry.domain) ? entry.domain : null;
}

/** Enabled mappings only — what a settings surface renders as "live". */
export function activeMappings(map) {
  const entries = Array.isArray(map) ? map : DEFAULT_DOMAIN_MAP;
  return entries.filter((e) => e.enabled === true && isDomain(e.domain));
}
