// ── Cast state classification (one table, five patches' worth of rules) ──────
//
// The cast precondition grew by accretion: five production fixes each added an
// inline exception to `if (status !== "approved") 409` — reseal (green+signed),
// stale pointer (report overwritten with Pack-not-found), first-cast self
// reference ({{PACK_ID:self}} frozen into v1), plus the 409-same-name and
// provenance-adoption branches inside the publish retry. Each was correct and
// each was invisible next to the others, so every new failure mode needed
// another patch in the same if-chain.
//
// This module is that if-chain as a decision table, with no I/O: callers do the
// one `getPack` fetch the self-reference rule needs, then ask here. Behaviour is
// byte-for-byte what the inline branches did — the tests that pin each patch
// (scripts/test-blueprints.mjs: reseal / stale pointer / 409-hint / self-pending /
// provenance adopter) are the guard that this stays true.

export const CAST_ADMISSION = {
  /** Draft approved, never cast — the ordinary path. */
  APPROVED: "approved",
  /** Already cast and the trial report is green + signed by the approver; re-cast
   *  to embed the signoff in the published manifest (add-blueprint-llm-assertions). */
  RESEAL: "reseal",
  /** Already cast but the report was overwritten by a stale-pointer error, so
   *  reseal can never hold; re-casting is the repair entry. */
  STALE_POINTER: "stale-pointer",
  /** Already cast but v1 froze an unresolved {{PACK_ID:self}}; re-casting resolves it. */
  SELF_PENDING: "self-pending",
  /** Anything else — approval must come first. */
  BLOCKED: "blocked",
};

const STALE_POINTER_ERROR_RE = /Pack (version )?not found/i;

/** True when a trial report carries the "the pack id I was given no longer
 *  exists" error — the signature of a pointer that needs repair. */
export function looksLikeStalePointerError(errors) {
  return Array.isArray(errors) && errors.some((e) => STALE_POINTER_ERROR_RE.test(String(e)));
}

/** True when a cast manifest still carries an unresolved self-reference: the
 *  first cast froze the placeholder because its own pack id did not exist yet. */
export function manifestCarriesSelfPlaceholder(manifest) {
  return Boolean(manifest && JSON.stringify(manifest).includes("{{PACK_ID:self}}"));
}

/**
 * Which admission rule lets this cast through (or why it cannot).
 *
 * Precedence mirrors the original if-chain: approved wins first, then the three
 * already-cast exceptions in the order they were introduced. `castPackManifest`
 * is only consulted for the self-pending rule, and only when the caller says it
 * could be fetched (same preconditions the route used before the fetch).
 *
 * @param {object} input
 * @param {object} input.blueprint
 * @param {string} input.userEmail
 * @param {object|null} [input.castPackManifest] the pack the blueprint points at
 * @returns {{allowed: boolean, reason: string}}
 */
export function classifyCastAdmission({ blueprint, userEmail, castPackManifest = null }) {
  if (!blueprint) return { allowed: false, reason: CAST_ADMISSION.BLOCKED };
  if (blueprint.status === "approved") return { allowed: true, reason: CAST_ADMISSION.APPROVED };
  if (blueprint.status !== "cast") return { allowed: false, reason: CAST_ADMISSION.BLOCKED };

  const report = blueprint.trialReport;
  const reseal =
    blueprint.approvedBy === userEmail &&
    report?.signoff?.by === userEmail &&
    report?.signoff?.reportRanAt === report?.ranAt;
  if (reseal) return { allowed: true, reason: CAST_ADMISSION.RESEAL };

  // Deliberately NOT gated on the approver: this rule exists so the blueprint
  // owner can repair the pointer at all; the approver discipline is enforced
  // separately (403) right after admission.
  if (blueprint.castPackId && looksLikeStalePointerError(report?.errors)) {
    return { allowed: true, reason: CAST_ADMISSION.STALE_POINTER };
  }

  // The approver discipline applies here because this rule needs a fetch the
  // route only performs for the approver (see the route's precondition).
  if (blueprint.castPackId && blueprint.approvedBy === userEmail && manifestCarriesSelfPlaceholder(castPackManifest)) {
    return { allowed: true, reason: CAST_ADMISSION.SELF_PENDING };
  }

  return { allowed: false, reason: CAST_ADMISSION.BLOCKED };
}

/** The publisher's answer that means "the id I was given is gone" — either a
 *  plain 404 or the same-name gate answering instead of the missing id (the
 *  facet shape observed live 2026-10-30: a dead pointer plus a live pack of the
 *  same name returns 409, so a 404-only rule never fired). */
export function isStalePointerAnswer(result) {
  if (!result || result.ok) return false;
  if (result.status === 404) return true;
  return result.status === 409 && /同名包已存在/.test(String(result?.body?.error ?? result?.error ?? ""));
}

/** Candidate pack ids the same-name 409 may name — the body's packId, or the
 *  first long opaque token in whatever the publisher said. */
export function sameNameCandidates(result) {
  if (!result || result.ok) return [];
  const hint = String(result.body?.packId ?? result.body?.error ?? result.error ?? "").match(
    /\b([A-Za-z0-9_-]{16,})\b/,
  );
  return [
    ...new Set([...(result.body?.packId ? [result.body.packId] : []), ...(hint ? [hint[1]] : [])]),
  ];
}

/** May we re-publish onto this existing pack? Only when the cast provenance
 *  proves it is THIS blueprint's own (a same-name pack may equally be someone
 *  else's product, or an official seed that took the name back). */
export function mayAdoptSameNamePack({ row, blueprintId, userEmail }) {
  if (!row || !blueprintId) return false;
  const ownerBlueprint = row?.manifest?._casting?.blueprintId;
  if (ownerBlueprint !== blueprintId) return false;
  const authorEmail = row?.authorEmail ?? row?.author_email ?? null;
  return !(authorEmail && authorEmail !== userEmail);
}
