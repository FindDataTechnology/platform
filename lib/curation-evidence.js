// ── Curation evidence (openspec: add-curation-evidence-gate, tasks 1.1–1.3) ─
//
// "What was reviewed, by whom, against which upstream pin" used to live in a
// Markdown ledger that nothing could check. This module turns it into fields on
// the catalogue entry, plus three pure judgements:
//
//   validateEvidence(evidence, {species})   shape errors, each with a path
//   evidenceState(entry, {today})           "complete" | "stale" | "missing"
//   evidenceSummary(entry)                  the outward-facing subset (no reviewer)
//
// Design notes that matter more than the code:
//
// · The COLLECTORS are not here and never will be (proposal: they belong to the
//   external registry's review pipeline). What paas owns is the SHAPE and the
//   VERDICT — so a hand-written evidence block and a pipeline-written one are
//   the same thing to every reader below.
// · Evidence state is a SEPARATE dimension from supply state (design D2).
//   `unsupplied` says "this deployment does not have it"; `missing` says "nobody
//   finished reviewing it". Collapsing them would let one hide the other.
// · An axis that stopped at "needs human" is INCOMPLETE, not "mostly done": the
//   gate exists to make that state visible instead of silently shippable.
// · `reviewValidUntil` empty = never expires. A date in the past = "stale" =
//   re-review, never "probably fine".

/** Axes every species must carry. */
export const AXES_BASE = Object.freeze(["security", "licence", "quality"]);

/** Axes a plugin entry must additionally carry (runbook's P1 / P2). */
export const AXES_PLUGIN = Object.freeze(["P1", "P2"]);

/** Verdict vocabulary. `needs-human` is a state, not a pass. */
export const AXIS_VERDICTS = Object.freeze(["pass", "reject", "needs-human"]);

/** Egress resolution: none, an explicit allowlist, or open (name it and justify). */
export const EGRESS_FORMS = Object.freeze(["none", "allowlist", "open"]);

/** States a reader may see. Only `complete` is shippable. */
export const EVIDENCE_STATES = Object.freeze(["complete", "stale", "missing"]);

/** Field whitelist for anything that leaves the platform (design D5). */
export const EVIDENCE_PUBLIC_FIELDS = Object.freeze(["licence", "pin", "egress", "axes", "reviewedAt", "reviewValidUntil"]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Axes required for one species. */
export function axesForSpecies(species) {
  return species === "plugin" ? [...AXES_BASE, ...AXES_PLUGIN] : [...AXES_BASE];
}

function validEgress(egress) {
  if (typeof egress === "string") {
    const text = egress.trim();
    if (!text) return false;
    if (EGRESS_FORMS.includes(text)) return true;
    // `allowlist(...)` is written in the catalog as one string; parse the form
    // rather than trusting the prefix, so a typo is refused instead of shipped.
    const m = /^allowlist\((.+)\)$/.exec(text);
    return !!m && m[1].split(",").every((host) => host.trim().length > 0);
  }
  if (isPlainObject(egress)) {
    if (!EGRESS_FORMS.includes(egress.kind)) return false;
    if (egress.kind !== "allowlist") return true;
    return Array.isArray(egress.hosts) && egress.hosts.length > 0 && egress.hosts.every((h) => typeof h === "string" && h.trim());
  }
  return false;
}

/**
 * Shape validation (task 1.1 + 1.2).
 *
 * @param {unknown} evidence
 * @param {{ species?: string }} [opts]
 * @returns {{error: string, path: string, code: string}[]}
 */
export function validateEvidence(evidence, { species = "pack" } = {}) {
  if (evidence === undefined || evidence === null) {
    return [{ error: "no evidence block — the entry is unreviewed", path: "evidence", code: "evidence_missing" }];
  }
  if (!isPlainObject(evidence)) {
    return [{ error: "evidence must be an object", path: "evidence", code: "evidence_not_object" }];
  }

  const errors = [];
  const required = axesForSpecies(species);

  if (!isPlainObject(evidence.axes)) {
    errors.push({ error: `evidence.axes must be an object carrying ${required.join(", ")}`, path: "evidence.axes", code: "evidence_axes_missing" });
  } else {
    for (const axis of required) {
      const result = evidence.axes[axis];
      if (!isPlainObject(result)) {
        errors.push({ error: `axis '${axis}' has no result (${required.join(", ")} are required for species ${species})`, path: `evidence.axes.${axis}`, code: "evidence_axis_missing" });
        continue;
      }
      if (!AXIS_VERDICTS.includes(result.verdict)) {
        errors.push({ error: `axis '${axis}' verdict must be one of ${AXIS_VERDICTS.join(", ")}`, path: `evidence.axes.${axis}.verdict`, code: "evidence_axis_verdict" });
      } else if (result.verdict === "needs-human") {
        // Incomplete by definition: a review that stopped short is not a review.
        errors.push({ error: `axis '${axis}' stopped at needs-human — an unfinished axis is incomplete evidence`, path: `evidence.axes.${axis}.verdict`, code: "evidence_axis_incomplete" });
      }
      if (typeof result.reason !== "string" || !result.reason.trim()) {
        errors.push({ error: `axis '${axis}' needs a one-line reason`, path: `evidence.axes.${axis}.reason`, code: "evidence_axis_reason" });
      }
    }
    // An axis invented for the wrong species is noise: it would suggest a review
    // step that does not exist for this material.
    for (const axis of Object.keys(evidence.axes)) {
      if (!required.includes(axis)) {
        errors.push({ error: `axis '${axis}' does not apply to species ${species}`, path: `evidence.axes.${axis}`, code: "evidence_axis_unexpected" });
      }
    }
  }

  const pin = evidence.pin;
  if (!isPlainObject(pin)) {
    errors.push({ error: "evidence.pin needs the upstream repo and a commit or tag", path: "evidence.pin", code: "evidence_pin_missing" });
  } else {
    if (typeof pin.repo !== "string" || !pin.repo.trim()) {
      errors.push({ error: "evidence.pin.repo is required", path: "evidence.pin.repo", code: "evidence_pin_repo" });
    }
    const hasCommit = typeof pin.commit === "string" && pin.commit.trim();
    const hasTag = typeof pin.tag === "string" && pin.tag.trim();
    if (!hasCommit && !hasTag) {
      errors.push({ error: "evidence.pin needs a commit or a tag (a floating branch is not a pin)", path: "evidence.pin", code: "evidence_pin_ref" });
    }
  }

  if (typeof evidence.licence !== "string" || !evidence.licence.trim()) {
    errors.push({ error: "evidence.licence needs an SPDX identifier", path: "evidence.licence", code: "evidence_licence" });
  }
  if (!validEgress(evidence.egress)) {
    errors.push({
      error: `evidence.egress must be 'none', 'open' or 'allowlist(host, …)' — got ${JSON.stringify(evidence.egress)}`,
      path: "evidence.egress",
      code: "evidence_egress",
    });
  }
  if (typeof evidence.reviewedBy !== "string" || !evidence.reviewedBy.trim()) {
    errors.push({ error: "evidence.reviewedBy is required (an unsigned review is not a review)", path: "evidence.reviewedBy", code: "evidence_reviewed_by" });
  }
  if (typeof evidence.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(evidence.reviewedAt)) {
    errors.push({ error: "evidence.reviewedAt must be an ISO date (YYYY-MM-DD)", path: "evidence.reviewedAt", code: "evidence_reviewed_at" });
  }
  if (evidence.reviewValidUntil !== undefined && evidence.reviewValidUntil !== null && evidence.reviewValidUntil !== "") {
    if (typeof evidence.reviewValidUntil !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(evidence.reviewValidUntil)) {
      errors.push({ error: "evidence.reviewValidUntil must be an ISO date or empty (empty = never expires)", path: "evidence.reviewValidUntil", code: "evidence_review_valid_until" });
    }
  }
  return errors;
}

function dayString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

/**
 * Task 1.3 + the read face's third dimension (design D2).
 *
 * @param {{species?: string, evidence?: object}} entry
 * @param {{ today?: string|Date }} [opts]
 * @returns {{ state: "complete"|"stale"|"missing", reasons: string[] }}
 */
export function evidenceState(entry, { today = new Date() } = {}) {
  const species = entry?.species ?? "pack";
  const errors = validateEvidence(entry?.evidence, { species });
  if (errors.length > 0) {
    return { state: "missing", reasons: errors.map((e) => `${e.path}: ${e.error}`) };
  }
  const until = entry.evidence.reviewValidUntil;
  // Empty means "no expiry". Comparing strings works because both sides are
  // ISO days; a timezone-sensitive Date compare would make the gate flip by hour.
  if (typeof until === "string" && until.trim() && dayString(until) < dayString(today)) {
    return { state: "stale", reasons: [`review expired on ${dayString(until)} — re-review or extend`] };
  }
  return { state: "complete", reasons: [] };
}

/** Only `complete` may be presented as supplied (spec: 缺证据不得呈现为可供给). */
export function isShippable(entry, opts) {
  return evidenceState(entry, opts).state === "complete";
}

/**
 * The outward subset (design D5): reviewer identity stays internal. Returning a
 * projection — rather than having each caller pick fields — is what keeps a new
 * internal field from leaking by default.
 */
export function evidenceSummary(entry, opts) {
  const { state, reasons } = evidenceState(entry, opts);
  const e = isPlainObject(entry?.evidence) ? entry.evidence : {};
  const out = { state };
  if (typeof e.licence === "string" && e.licence.trim()) out.licence = e.licence;
  if (isPlainObject(e.pin)) out.pin = { repo: e.pin.repo ?? null, ...(e.pin.commit ? { commit: e.pin.commit } : {}), ...(e.pin.tag ? { tag: e.pin.tag } : {}) };
  if (e.egress !== undefined) out.egress = e.egress;
  if (isPlainObject(e.axes)) {
    out.axes = Object.fromEntries(
      Object.entries(e.axes).map(([axis, result]) => [axis, { verdict: result?.verdict ?? null }]),
    );
  }
  // The deadline is outward on purpose (it is the operator's "when must I
  // re-review" signal, and the ledger prints it): not only on an expired entry,
  // because a surface that shows "reviewed" without saying until when invites
  // the reader to assume "forever".
  if (typeof e.reviewValidUntil === "string" && e.reviewValidUntil.trim()) out.reviewValidUntil = e.reviewValidUntil;
  else if (state === "stale") out.reviewValidUntil = null;
  if (state !== "complete" && reasons.length > 0) out.reasons = reasons;
  return out;
}
