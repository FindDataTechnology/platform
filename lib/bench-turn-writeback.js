// ── Runtime verdict writeback (openspec bind-fleet-turn-to-bench-verdict) ────
//
// Why this is a module of its own, and why it is called at the turn seam rather
// than by a tool the agent may or may not invoke:
//
//   Before this change the ONLY caller of `recordRun` was the `bench_run_report`
//   MCP tool — i.e. whether a round left a verdict fact on the peer depended on
//   the executing agent REMEMBERING to call it. A round that did not call it did
//   not exist on the ledger, and `runner_ref`'s `#<round>` half was the agent's
//   own count, so a replay after a crash could not land on the same row.
//
//   This module closes that: the seam that closes the attempt calls here, the
//   idempotency anchor is the turn address the ledger already minted, and the
//   reference it gets back is stored on the claim row (`setBenchRunId`), which
//   is the one place mutable per-attempt fields may live.
//
// Three rules it keeps, all of them because a turn must never be taken down by
// a peer that is slow, absent, or not yet deployed:
//
//   • Never throws. Every failure becomes a `skipped`/`error` fact. The turn's
//     own outcome is already recorded by the time this runs.
//   • Never blocks the seam. It runs AFTER the result row and the claim close
//     are written, and the caller does not await it (see `end()`).
//   • Never guesses the ruler. A round with no declared rubric reports a PLAIN
//     run (no verdict identity) — it does NOT fabricate one. `inconclusive` is a
//     verdict the peer accepts; a made-up ruler digest is not.

import { recordRun, resolveOpsConfig } from "./bench-ops-client.js";
import { BenchProposalError } from "./bench-proposal-client.js";

/** The four outcome values the peer's run ledger accepts. Mirrors the closed
 *  set in law-bench `agent_runs.OUTCOMES` minus `running` (a writeback is never
 *  "still running"). Duplicated on purpose: an unknown value is a 422 three
 *  hops later that names nothing useful. */
export const RUN_OUTCOMES = Object.freeze(["ok", "partial", "failed", "skipped"]);

/** Map the claim's terminal reason onto the run ledger's outcome vocabulary.
 *  `interrupted` / `cancelled` / `lease_expired` are NOT failures (spec:
 *  被打断必须与跑失败在读数上分开); `skipped` produced no attempt at all. */
export function outcomeForCloseReason(reason) {
  switch (reason) {
    case "ok": return "ok";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "interrupted":
    case "cancelled":
    case "lease_expired": return "skipped";
    default: return null; // an unknown reason is not guessed into one of four
  }
}

/**
 * Build the recordRun arguments for one finished attempt, or `null` when the
 * attempt cannot be reported (no post, no fleet credential, no domain).
 *
 * `post` is the member id (ADR-0031: a member row IS the post) and `role` is
 * its title — both are read off the handle the ledger already resolved, not
 * inferred from the prompt.
 */
export function buildWritebackArgs({ handle, post, role, outcome, turnRef, counts, artifactRefs, verdict }) {
  if (!handle?.turnRef && !turnRef) return null;
  if (!post || !role) return null;
  const runOutcome = outcomeForCloseReason(outcome);
  if (!runOutcome) return null;
  return {
    post,
    role,
    outcome: runOutcome,
    // The round number satisfies the client's shape check; it no longer decides
    // identity — `turnRef` does (see runnerAnchor in the client).
    round: 1,
    turnRef: turnRef ?? handle.turnRef,
    ...(counts ? { counts } : {}),
    ...(artifactRefs ? { artifactRefs } : {}),
    ...(verdict ? { verdict } : {}),
  };
}

/**
 * Fire the writeback for one attempt and record the reference on the claim.
 *
 * @returns {Promise<{status, verdictState?, benchRunId?, reason?}>}
 *   status ∈ `sent` | `skipped` | `error`. Deliberately never throws.
 */
export async function writebackTurnVerdict({
  claims,
  handle,
  post,
  role,
  outcome,
  turnRef,
  counts = null,
  artifactRefs = null,
  verdict = null,
  env = process.env,
  transport,
} = {}) {
  const ref = turnRef ?? handle?.turnRef ?? null;
  const args = buildWritebackArgs({ handle, post, role, outcome, turnRef: ref, counts, artifactRefs, verdict });
  if (!args) return { status: "skipped", reason: "incomplete-attribution" };

  // No peer configured (desktop build, local dev, a cell without BENCH_URL):
  // skip WHOLE, and say so. This is the normal state for those deployments, not
  // a failure — the turn outcome is already recorded and must not be touched.
  try {
    resolveOpsConfig(env);
  } catch (e) {
    if (e instanceof BenchProposalError) return { status: "skipped", reason: "not-configured" };
    return { status: "skipped", reason: "config-read-failed" };
  }

  try {
    const out = await recordRun(args, { env, ...(transport ? { transport } : {}) });
    // Store the peer's id on the claim (nullable column, write-once). A claim
    // store that is absent (no claims lane) simply skips this — the absence of
    // the reference is an honest "not stored", not a writeback failure.
    if (out?.id != null && claims && ref) {
      try { claims.setBenchRunId(ref, String(out.id)); } catch { /* best-effort */ }
    }
    return {
      status: "sent",
      verdictState: out?.verdictState ?? "not-sent",
      benchRunId: out?.id ?? null,
    };
  } catch (e) {
    // A 4xx (refused), a 404 (not deployed), a timeout — all become a visible
    // fact, never a thrown error into the seam. `dropped` is distinct from this:
    // `dropped` means the peer accepted the run but not the verdict; `error`
    // means the report itself did not land.
    return { status: "error", reason: e?.kind ?? "transport-error", message: e?.message ?? String(e) };
  }
}
