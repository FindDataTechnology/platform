// ── Run workbench host (fleet-run-workbench §2) ─────────────────────────────
//
// The server-side half of the run workbench: it owns the deployment facts
// (base directory, data root, backend) and hands the primitive in
// lib/run-worktree.js the arguments it needs. The worker/cell spawn path
// (server/worker-slots.js) consumes it as `ctx.runWorkbench`; that consumer
// only knows `acquire` / `release` / `sweep`, never git or paths — keeping the
// filesystem mechanics in the primitive lets both be tested apart.
//
// Backend is the PLATFORM's call (spec: 不由使用者选择): a base inside a git
// repo runs each run in a `git worktree`, everything else in a plain directory.
// Detection is per base and cached — the base is fixed for the life of a cell —
// so it runs at most one `git rev-parse` per process, and a failure reads as
// `directory` (a deployment without git is supported, not an error).

import { create as createWorkbench, release as releaseWorkbench, sweep as sweepWorkbenches, usageOf, detectBackend, diffSince, sanitizeRef } from "../lib/run-worktree.js";

// Keep a finished run's bench long enough to inspect, then let the sweeper reap
// it. 0 deletes on release (no post-run inspection window); the sweeper still
// converges a killed run's orphan within one interval. Operators raise this
// once the §4 inspection surface is live.
function keepDaysFromEnv() {
  const n = Number(process.env.WORKBENCH_KEEP_DAYS || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function createRunWorkbenchHost({ base, dataRoot }) {
  let backendPromise = null;
  const backendOf = () => (backendPromise ??= detectBackend({ base }));
  const keepDays = () => keepDaysFromEnv();
  // Which benches a live run holds RIGHT NOW. This is the process's own truth:
  // a killed process forgets it, so its orphan reads as dead and the sweeper
  // reaps it — exactly the convergence the spec wants. Anything in the set is
  // skipped by sweep() no matter its age.
  const live = new Set();

  return {
    base,
    dataRoot,

    /**
     * Create this run's bench. `handle` is the run-ledger handle whose
     * `claimRef` is the one address shared with the claim row (design D1);
     * a handle without one (no claim store) falls back to the task id so a
     * bench never collides across runs.
     *
     * Throws `WORKBENCH_CREATE_FAILED` on failure — the caller MUST close the
     * run as interrupted; falling back to a shared directory is never right.
     */
    async acquire(task, handle) {
      const ref = handle?.claimRef || task?.id;
      const backend = await backendOf();
      // Mark LIVE before create() touches the filesystem. sweep() with
      // keepDays=0 skips the age check, so a directory that exists but is not
      // yet in `live` would be reaped on sight — the bench would vanish
      // mid-spawn. sanitizeRef is the exact key create() will use, so the mark
      // and the returned workbenchRef agree. A failed create unmarks.
      let key = null;
      try {
        key = sanitizeRef(ref);
      } catch { /* empty/invalid ref: create() throws the same, handled below */ }
      if (key) live.add(key);
      try {
        const wb = await createWorkbench({ base, run: ref, dataRoot, backend });
        live.add(wb.workbenchRef); // belt-and-braces: same key, in case create normalized differently
        return wb;
      } catch (err) {
        if (key) live.delete(key);
        throw err;
      }
    },

    /** Non-blocking by contract (spec: slot return wins). Errors are swallowed. */
    async release(wb) {
      if (wb?.workbenchRef) live.delete(wb.workbenchRef);
      return releaseWorkbench({ workbenchRef: wb.workbenchRef, backend: wb.backend, dataRoot, keepDays: keepDays() });
    },

    async usage(wb) {
      return usageOf({ workbenchRef: wb.workbenchRef, dataRoot });
    },

    /**
     * What this run changed (spec: 每回合的改动可归属到那一次运行). Host-side —
     * the workbench is the run's own worktree/empty dir, so the answer needs no
     * child cooperation. MUST be called BEFORE release() (a released worktree is
     * gone). Returns the diffSince() shape; `ok:false` MUST surface as
     * "未取得 + 原因", never as "no changes".
     */
    async changes(wb) {
      return diffSince({ dir: wb.cwd, backend: wb.backend });
    },

    /** Reap dead benches older than the retention window; worktree metadata too. */
    async sweep() {
      const backend = await backendOf();
      return sweepWorkbenches({ dataRoot, keepDays: keepDays(), isLive: (ref) => live.has(ref), repo: backend === "worktree" ? base : null });
    },
  };
}
