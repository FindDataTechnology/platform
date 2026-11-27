// server/dsh-mcp-delivery.js — the credential-change delivery decision for
// dshUpdateMcp (add-line-credential-renewal D5, hardened after the fleet-cell
// incident 2026-10-24 13:46).
//
// The incident: the writer composed the fresh patch correctly (wire-ops back
// in the file), but the runtime child kept the old one until a platform
// restart — the one-shot `bridge.restart()` had collided with a restart
// already in flight (dsh-bridge throws "dsh restart already in progress"),
// reapplyProfile's catch swallowed it, and nothing retried. Delivery of a
// renewed credential must therefore be a DECIDED, OBSERVED, RETRIED process,
// never a fire-and-forget call:
//
//   change detected → idle? restart now (retry on collision)
//                  → busy? defer to the turn boundary (poller + idle drain),
//                    with a hard cap — after maxDeferredMs a wedged stream
//                    must not hold the credential hostage (interrupted turns
//                    are re-runnable; an expired token fails every turn).
//
// "Busy" is whatever predicate the cell wires in (fix-fleet-round-discipline
// D1): the shared child is busy when the web turn streams OR any
// collector-registered turn (cron / delegation / bot-relay) is in flight —
// the wiring predicate, not this module, is what must stay honest.
// Non-credential-shaped restarts (profile fallback, skills patch) ride the
// same controller with their own label (D3) so no patch-delivery path can
// bypass the busy check.
//
// Every branch logs. Extracted from server.js so the branch matrix is unit
// testable without a bridge.

const RETRY_DELAYS_MS = [2000, 4000, 8000];
const DEFAULT_MAX_DEFERRED_MS = 5 * 60 * 1000;
const POLL_MS = 250;

export function createCredentialDelivery({
  isStreaming = () => false,
  restart = async () => {},
  log = console,
  maxDeferredMs = DEFAULT_MAX_DEFERRED_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  now = () => Date.now(),
} = {}) {
  let pending = null; // { patchPath, deferredAt }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Restart with collision retry: dsh-bridge refuses a concurrent restart —
  // that is a transient loss, not a delivery failure. Serializing behind the
  // mutation chain usually prevents this; the retry covers the paths that run
  // outside it (runtimeApplying fast-path) and future callers.
  const restartWithRetry = async (patchPath, label) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await restart({ mcpPatchPath: patchPath });
        log.log(`[mcp-delivery] ${label}: runtime child restarted with the fresh patch (attempt ${attempt + 1})`);
        return true;
      } catch (e) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) {
          log.error(`[mcp-delivery] ${label}: restart failed after ${retryDelaysMs.length + 1} attempts: ${e?.message || e}`);
          return false;
        }
        log.warn(`[mcp-delivery] ${label}: restart collided (${e?.message || e}) — retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  };

  const drain = async () => {
    const p = pending;
    if (!p) return;
    pending = null;
    const waitedMin = Math.round((now() - p.deferredAt) / 60000);
    log.log(`[mcp-delivery] ${p.label ?? "deferred"}: deferred restart executing (waited ${waitedMin}min)`);
    await restartWithRetry(p.patchPath, p.label ?? "deferred");
  };

  const armPoller = () => {
    const poll = setInterval(() => {
      if (!pending) return clearInterval(poll);
      if (isStreaming()) {
        // Hard cap: a stream wedged past the cap must not hold the credential
        // hostage — the next turn fails on an expired token otherwise.
        if (now() - pending.deferredAt < maxDeferredMs) return;
        log.warn(`[mcp-delivery] credential restart deferred past ${Math.round(maxDeferredMs / 60000)}min cap — forcing (streaming still true; an in-flight turn may be interrupted and re-run)`);
      }
      void drain();
    }, POLL_MS);
    poll.unref?.();
  };

  return {
    // The decision point dshUpdateMcp calls after rewriting the patch.
    // `label` names the delivery in the logs — credential changes by default,
    // non-credential fallback restarts under their own name (D3). Returns
    // "restarted" | "deferred" | "skipped" for the caller to log.
    async onCredentialChange(patchPath, { label = "credential change" } = {}) {
      if (isStreaming()) {
        const first = !pending;
        pending = { patchPath, deferredAt: pending?.deferredAt ?? now(), label };
        if (first) armPoller();
        log.log(`[mcp-delivery] ${label} deferred until the turn boundary (the shared child is busy)`);
        return "deferred";
      }
      await restartWithRetry(patchPath, label);
      return "restarted";
    },

    // Turn-boundary drain: call from onRuntimeIdle / the pre-round hook.
    // Idle-only — the streaming check is re-evaluated here so a drain racing
    // a newly started turn does not interrupt it (the poller's cap still
    // applies to that pending restart).
    async drainIfIdle() {
      if (!pending || isStreaming()) return false;
      await drain();
      return true;
    },

    get pending() {
      return Boolean(pending);
    },
  };
}
