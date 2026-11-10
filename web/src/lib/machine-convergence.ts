// machine-convergence.ts — pure derivation behind the machine detail drawer's
// convergence indicator (add-machine-lifecycle-console). Compares the cloud's
// desired version against the version the machine last reported consuming
// (cell_detail.merge.desiredVersionSeen), qualified by presence and snapshot
// freshness. Read-only by design: the result drives presentation only — the
// page never offers an action that pretends to drive the machine.

export type ConvergenceState = "synced" | "converging" | "awaiting" | "diverged" | "unknown" | "stale";

export interface ConvergenceInput {
  /** Cloud-side desired version (0 = nothing ever authored). */
  desiredVersion: number;
  /** Latest cell_detail snapshot as stored, or null when never reported. */
  detail: { at: number; merge?: { desiredVersionSeen?: number | null } | null } | null;
  /** Derived presence: online | silent | never_reported. */
  silence: "online" | "silent" | "never_reported";
  /** Divergence streak from the machine's health (episode open when > 0). */
  divergenceStreak?: number;
  /** Clock + staleness window, injectable for tests. */
  now?: number;
  staleAfterMs?: number;
}

export interface ConvergenceVerdict {
  state: ConvergenceState;
  /** The machine-reported consumed version, when present. */
  seenVersion: number | null;
}

const DEFAULT_STALE_MS = 5 * 60_000;

export function deriveConvergence(input: ConvergenceInput): ConvergenceVerdict {
  const { desiredVersion, detail, silence, divergenceStreak = 0 } = input;
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_MS;

  // No snapshot at all: nothing has ever been reported — the drawer's own
  // "never reported" block covers the story; the indicator must not guess.
  if (!detail || typeof detail.at !== "number") {
    return { state: "unknown", seenVersion: null };
  }
  // A stale snapshot reads as "unknown", never as a fresh verdict.
  if (now - detail.at > staleAfterMs) {
    return { state: "stale", seenVersion: detail.merge?.desiredVersionSeen ?? null };
  }
  const seen = detail.merge?.desiredVersionSeen;
  if (typeof seen !== "number") {
    // Older machines may not report merge info: honest unknown, not fake sync.
    return { state: "unknown", seenVersion: null };
  }
  const aligned = seen >= desiredVersion;
  if (aligned && divergenceStreak > 0) {
    return { state: "diverged", seenVersion: seen };
  }
  if (aligned) {
    return { state: "synced", seenVersion: seen };
  }
  // Version behind: the machine will pull on its own beat if it can.
  return silence === "online" ? { state: "converging", seenVersion: seen } : { state: "awaiting", seenVersion: seen };
}
