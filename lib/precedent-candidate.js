// ── Precedent candidates (widen-deputy-to-personal-domains 4.x) ─────────────
//
// When the owner overrules the agent, the correction is the most valuable
// signal the system gets — and the most dangerous to apply automatically. So it
// becomes a CANDIDATE, never a rule:
//
//   propose → owner decides → only then may it be cited
//
// Same discipline as persona-self-evolution (修订由提议产生、永不直接生效),
// separate table because `persona_candidates` is keyed to a resolvable persona
// and stores persona text that gets sanity-scanned and diffed. A precedent rule
// has neither. Sharing the table would have meant either faking a persona or
// weakening that table's invariants.
//
// Leaf module: imports nothing.

export const CANDIDATE_STATUS = Object.freeze({
  CANDIDATE: "candidate",
  APPROVED: "approved",
  REJECTED: "rejected",
});

const MIN_RULE_LENGTH = 8;
const MAX_RULE_LENGTH = 500;

/**
 * Collapse whitespace so "同类交期最多延1天" and "同类交期最多延 1 天" hash the
 * same. Without this, the same rule re-proposed with different spacing would
 * slip past the dedupe and the owner would review it twice.
 */
export function normalizeRuleText(text) {
  if (typeof text !== "string") return null;
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Validate a proposed rule. Returns { ok, rule } or { ok: false, error }.
 *
 * Rejections are conservative on purpose: a rule that is too short to mean
 * anything becomes a precedent that means anything the agent wants it to.
 */
export function validateRule(text) {
  const rule = normalizeRuleText(text);
  if (!rule) return { ok: false, error: "rule text is required" };
  if (rule.length < MIN_RULE_LENGTH) {
    return { ok: false, error: `rule text is too short to constrain anything (min ${MIN_RULE_LENGTH} chars)` };
  }
  if (rule.length > MAX_RULE_LENGTH) {
    return { ok: false, error: `rule text is too long (max ${MAX_RULE_LENGTH} chars)` };
  }
  return { ok: true, rule };
}

/**
 * Stable identity for dedupe. A plain hash of the normalized text: the owner
 * should never be asked to review the same sentence twice, and a rejected rule
 * must be recognisable when the agent tries to re-propose it.
 */
export function ruleKey(text) {
  const rule = normalizeRuleText(text);
  if (!rule) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < rule.length; i += 1) {
    hash ^= rule.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Can this candidate be cited? Only after a human said yes. A pending or
 * rejected candidate is not a weaker precedent — it is not a precedent.
 */
export function isCitableCandidate(status) {
  return status === CANDIDATE_STATUS.APPROVED;
}
