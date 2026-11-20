// ── Runtime revisions (harden-agent-runtime-spine, runtime-revision) ────────
//
// A version of a running configuration whose IDENTITY IS ITS CONTENT.
//
// Why the identity cannot be a name or a counter: `provisionFleetFromTemplate`
// re-derives a fleet from a template plus overrides, and the same name can be
// re-cast with different content. If "v3" meant two different things last week
// and today, then "roll back to v3" is a gamble. The fingerprint makes it a
// lookup: either the content is reproducible or the rollback is refused.
//
// Two rules this module owns, and nothing else does:
//   1. A revision MAY not be promoted without a trial recorded UNDER THE SAME
//      fingerprint. "We tested it" is only meaningful about the exact bytes.
//   2. Rollback is a POINTER MOVE to an existing revision, never a re-cast of
//      something that looks like it. A target whose fingerprint no longer
//      reproduces is reported as divergence and refused — an approximation of
//      the old version is worse than an honest outage, because it looks fixed.
//
// Storage-free by design (like work-lease.js): the caller supplies a small
// store; the rules are pure and testable without one.

export const REVISION_STATES = Object.freeze(["candidate", "active", "retired"]);

/** A revision belongs to a deployment (pack deployment path), not to a fleet. */
export function revisionRecord({
  fingerprint,
  name = null,
  packId = null,
  packVersion = null,
  overrides = null,
  createdAt = Date.now(),
  state = "candidate",
  trial = null,
} = {}) {
  if (!fingerprint || typeof fingerprint !== "string") {
    throw Object.assign(new Error("a revision needs a fingerprint — its identity is its content"), { code: "REVISION_NO_FINGERPRINT" });
  }
  return {
    // The id IS the fingerprint: two paths to the same content are one version.
    revisionId: fingerprint,
    fingerprint,
    name,
    packId,
    packVersion,
    overrides,
    createdAt,
    state,
    trial,
  };
}

/**
 * Attach a trial report. A report whose own fingerprint disagrees with the
 * revision's is not "close enough" — it is evidence about a different build.
 */
export function attachTrial(revision, trial) {
  if (!trial) return { ok: false, reason: "trial-required" };
  if (trial.fingerprint != null && trial.fingerprint !== revision.fingerprint) {
    return { ok: false, reason: "trial-fingerprint-mismatch", expected: revision.fingerprint, got: trial.fingerprint };
  }
  // "No assertion" is not "passed" — a trial with zero assertions cannot be
  // green (the same rule blueprint-trial already enforces).
  const assertions = Array.isArray(trial.assertions) ? trial.assertions : [];
  const undecided = assertions.filter((a) => a?.pass !== true && a?.pass !== false);
  const green = assertions.length > 0 && assertions.every((a) => a?.pass === true);
  return {
    ok: true,
    revision: {
      ...revision,
      trial: {
        ...trial,
        assertions,
        // Made explicit so a reader never has to infer it from a missing key.
        undecided: undecided.length,
        green,
        recordedAt: trial.recordedAt ?? Date.now(),
      },
    },
  };
}

/**
 * The promotion decision. Called BEFORE any pointer moves.
 *
 * @param {object} p
 * @param {object} p.target            the revision being promoted
 * @param {string} p.currentFingerprint what is running now (null on first deploy)
 * @param {boolean} [p.humanOverride]  an explicit human decision to skip the trial
 * @param {string|null} [p.overrideReason]
 * @param {string|null} [p.overriddenBy]
 */
export function decidePromotion({ target, currentFingerprint = null, humanOverride = false, overrideReason = null, overriddenBy = null } = {}) {
  if (!target?.fingerprint) return { ok: false, reason: "no-target" };
  if (currentFingerprint && target.fingerprint === currentFingerprint) {
    return { ok: true, noop: true, reason: "already-active" };
  }
  const trial = target.trial ?? null;
  if (trial && trial.fingerprint != null && trial.fingerprint !== target.fingerprint) {
    return { ok: false, reason: "trial-fingerprint-mismatch" };
  }
  const hasTrial = Boolean(trial) && Array.isArray(trial.assertions) && trial.assertions.length > 0;
  if (!hasTrial) {
    if (!humanOverride) {
      return { ok: false, reason: "no-trial", message: "this revision has no trial under its fingerprint — run one, or override by hand with a reason" };
    }
    // A human MAY skip the trial, but the skip is a recorded fact, not a
    // silent equivalence: without it the audit trail says "promoted" and
    // nothing says "nobody tested this".
    if (!overrideReason || !overriddenBy) {
      return { ok: false, reason: "override-needs-reason", message: "an override must carry who did it and why" };
    }
    return { ok: true, overridden: true, reason: "human-override", override: { reason: overrideReason, by: overriddenBy, at: Date.now() } };
  }
  if (trial.green !== true) {
    // A recorded trial that did not pass is not promotable by default either —
    // the same override lane applies, with the same audit requirement.
    if (!humanOverride || !overrideReason || !overriddenBy) {
      return { ok: false, reason: "trial-not-green", message: "the recorded trial did not pass every assertion" };
    }
    return { ok: true, overridden: true, reason: "human-override-after-failed-trial", override: { reason: overrideReason, by: overriddenBy, at: Date.now() } };
  }
  return { ok: true, reason: "trial-green" };
}

/**
 * The rollback decision: is the target still reproducible?
 *
 * `currentFingerprintOfTarget` is what a fresh materialization of the target
 * produces NOW (the caller composes it and hashes). A mismatch means a
 * dependency drifted — the label still says the old version, the content does
 * not, and rolling back to it would install something nobody ever tested.
 */
export function decideRollback({ target, currentFingerprintOfTarget = null } = {}) {
  if (!target?.fingerprint) return { ok: false, reason: "no-target" };
  if (currentFingerprintOfTarget == null) {
    // No way to re-derive it: refuse rather than trust the label.
    return { ok: false, reason: "cannot-reproduce", message: "the target revision could not be re-materialized, so there is nothing to prove it is the version it claims" };
  }
  if (currentFingerprintOfTarget !== target.fingerprint) {
    return {
      ok: false,
      reason: "diverged",
      message: "the target no longer reproduces its fingerprint — a dependency drifted",
      expected: target.fingerprint,
      got: currentFingerprintOfTarget,
    };
  }
  return { ok: true, reason: "reproduced" };
}

/**
 * The audit record for a governance action. Both verbs write one; the shape is
 * the same on purpose so a reader does not need to know which happened first.
 */
export function governanceRecord({ action, from = null, to = null, by = null, reason = null, at = Date.now(), overridden = false, override = null } = {}) {
  if (action !== "promote" && action !== "rollback") {
    throw Object.assign(new Error(`unknown governance action '${action}'`), { code: "BAD_ACTION" });
  }
  return { action, from, to, by, reason, at, overridden, override };
}
