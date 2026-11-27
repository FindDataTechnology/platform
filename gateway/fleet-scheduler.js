// ── Fleet scheduler (add-fleet-scheduler) ───────────────────────────────────
//
// The fleet's control loop, resident in the facet's packs service (the single
// writer for fleet decisions — one replica, no election). Two jobs:
//
//   1. FAILBACK-BY-REPOINT: a runner whose heartbeat went stale past the
//      threshold loses its entries to the healthy runner with the most budget
//      headroom — the registry entry's url + assignment flip, the target
//      hosts on its next poll. Failover is a COLD rebuild (pack/persona
//      re-materialize from the registry); warm session transcripts die with
//      the node, the agent does not.
//   2. PLACEMENT HINT: exposes pickPlacement() so the deploy route can auto-
//      place untagged deploys on the least-loaded healthy runner when the
//      fleet holds more than one machine.
//
// Hysteresis: a moved entry never moves back. A recovered runner re-enters
// the pool as a TARGET only — its old entries stay where they were moved.
// Health source: the fleet observer's board (runner heartbeats, sampled
// every ~30s by the runners themselves).

import { planAgentPort, resolveAgentPort } from "../lib/agent-serving.js";

const RUNNER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Desktop seats (add-desktop-fleet-runner ③): a runner whose id carries the
// desktop- prefix, or whose runner_stats self-reports desktop, is OWNED
// territory for the cloud loop — it appears on the board (monitoring) but is
// invisible to every control decision: never a failover source (its offline
// is "closed the app", not death — re-pointing its entries would run them,
// and bill them, somewhere the owner never chose), never a placement target
// (auto-placement must not land cloud work on a customer laptop), never
// orphan-reaped (board pruning of an offline seat leaves its entries waiting
// for its return, exactly like a tagged cloud runner behind a partition).
const isDesktopRunner = (id, row = null) =>
  /^desktop-/i.test(String(id || "")) || row?.desktop === true;

export function createFleetScheduler({
  // cfg: { staleMs, intervalMs }
  config = {},
  // { listAgents(), getAgent(path), putAgent(path, body) } — registry, service-credentialed
  registry,
  // async () => { runners: { [id]: { seen_at, children, budget_mb, budget_mb_limit } } }
  boardFetch,
  // () => [{ id, baseUrl, portBase, portSpan }] — the fleet table
  fleetRows,
  log = console,
  now = () => Date.now(),
}) {
  const staleMs = config.staleMs ?? 90_000;

  const healthy = (board) => {
    const out = [];
    for (const [id, r] of Object.entries(board?.runners ?? {})) {
      if (!RUNNER_ID_RE.test(id) || !Number.isFinite(r?.seen_at)) continue;
      if (isDesktopRunner(id, r)) continue;
      if (now() - r.seen_at <= staleMs) out.push({ id, ...r });
    }
    return out;
  };
  const stale = (board) => {
    const out = [];
    for (const [id, r] of Object.entries(board?.runners ?? {})) {
      if (!RUNNER_ID_RE.test(id) || !Number.isFinite(r?.seen_at)) continue;
      if (isDesktopRunner(id, r)) continue;
      if (now() - r.seen_at > staleMs) out.push({ id, ...r });
    }
    return out;
  };

  // Least-loaded healthy runner EXCLUDING the named ones: most budget
  // headroom first, fewer children breaking ties.
  const pickPlacement = (board, { exclude = [] } = {}) => {
    const skip = new Set(exclude);
    const cands = healthy(board).filter((r) => !skip.has(r.id));
    if (cands.length === 0) return null;
    return cands.sort((a, b) => {
      const ha = (a.budget_mb_limit ?? 0) - (a.budget_mb ?? 0);
      const hb = (b.budget_mb_limit ?? 0) - (b.budget_mb ?? 0);
      if (hb !== ha) return hb - ha;
      return (a.children ?? 0) - (b.children ?? 0);
    })[0];
  };

  const entriesOf = async () => {
    const doc = await registry.listAgents();
    return Array.isArray(doc) ? doc : (doc?.agents ?? doc?.items ?? []);
  };

  // One reconciliation pass. Throws only on unexpected errors; per-entry
  // failures are logged and skipped (the next pass retries).
  async function tick() {
    let board = null;
    try {
      board = await boardFetch();
    } catch (e) {
      log.warn(`[fleet-scheduler] board unreachable — pass skipped: ${e?.message || e}`);
      return { moved: 0 };
    }
    if (!board?.runners) {
      log.log("[fleet-scheduler] board returned no runners — pass skipped");
      return { moved: 0 };
    }
    const rows = fleetRows() ?? [];
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const defaultRunnerId = rows[0]?.id ?? null;
    const dead = stale(board);
    if (dead.length === 0 && healthy(board).length === 0) return { moved: 0 };

    let entries;
    try {
      entries = await entriesOf();
    } catch (e) {
      log.warn(`[fleet-scheduler] registry listing failed — pass skipped: ${e?.message || e}`);
      return { moved: 0 };
    }

    // ORPHAN detection (live drill finding): the observer PRUNES long-dead
    // runners from the board entirely, so staleness alone never fires for
    // them. An entry assigned (explicitly, or untagged→default) to a fleet
    // row whose runner is ABSENT from the board is orphaned when that row is
    // past the provisioning grace (a brand-new runner being booted up keeps
    // its pre-assigned entries for the grace window).
    const boardIds = new Set(Object.keys(board.runners ?? {}));
    const graceMs = config.orphanGraceMs ?? 600_000;
    const orphaned = new Map(); // runnerId → true
    for (const e of entries) {
      const rid = e?.metadata?.runner_id ?? defaultRunnerId;
      if (rid == null || boardIds.has(rid) || orphaned.has(rid)) continue;
      // A desktop seat pruned from the board is offline, not orphaned: its
      // entries wait for the seat to come back (never re-pointed, never billed
      // elsewhere).
      if (isDesktopRunner(rid, null)) continue;
      const row = rowsById.get(rid);
      if (!row || (Number.isFinite(row.createdAt) && now() - row.createdAt < graceMs)) continue;
      orphaned.set(rid, true);
    }
    for (const id of orphaned.keys()) {
      if (!dead.some((d) => d.id === id)) dead.push({ id, seen_at: 0, pruned: true });
    }
    if (dead.length === 0) return { moved: 0 };

    let moved = 0;
    for (const deadRunner of dead) {
      const isDefault = deadRunner.id === defaultRunnerId;
      const mine = entries.filter((e) => {
        const rid = e?.metadata?.runner_id ?? null;
        return rid === deadRunner.id || (isDefault && rid === null);
      });
      if (mine.length === 0) continue;
      log.warn(`[fleet-scheduler] runner '${deadRunner.id}' ${deadRunner.pruned ? "absent from the board (pruned)" : `stale (${Math.round((now() - deadRunner.seen_at) / 1000)}s)`} — re-pointing ${mine.length} entr(y/ies)`);

      // Occupancy per target slice, maintained across this wave.
      const occupiedByTarget = new Map(); // runnerId → Map(port → path)
      const occupiedFor = (targetId) => {
        if (!occupiedByTarget.has(targetId)) {
          const row = rowsById.get(targetId);
          const m = new Map();
          for (const e of entries) {
            const rid = e?.metadata?.runner_id ?? (defaultRunnerId ?? "");
            if (rid !== targetId || !e?.path) continue;
            m.set(resolveAgentPort(e, { base: row?.portBase ?? 8791, span: row?.portSpan ?? 32 }), e.path);
          }
          occupiedByTarget.set(targetId, m);
        }
        return occupiedByTarget.get(targetId);
      };

      for (const entry of mine) {
        // Resolve (target, plan) over the candidates in load order: the
        // first runner whose port span has room wins. A full span falls
        // through to the next candidate; exhaustion everywhere stops the wave
        // for this entry (the next pass retries).
        let resolved = null;
        const tried = [deadRunner.id];
        for (;;) {
          const target = pickPlacement(board, { exclude: tried });
          if (!target) break;
          tried.push(target.id);
          const row = rowsById.get(target.id);
          if (!row) {
            log.warn(`[fleet-scheduler] target '${target.id}' has no fleet row — next candidate`);
            continue;
          }
          const occupied = occupiedFor(target.id);
          try {
            const plan = planAgentPort(entry.path, { base: row.portBase ?? 8791, span: row.portSpan ?? 32, occupied, existing: null, runnerLabel: target.id });
            resolved = { target, row, occupied, plan };
            break;
          } catch {
            log.warn(`[fleet-scheduler] target '${target.id}' span full — next candidate for '${entry.path}'`);
          }
        }
        if (!resolved) {
          log.warn(`[fleet-scheduler] no target with room — '${entry.path}' stays on stale '${deadRunner.id}'`);
          break;
        }
        const { target, row, occupied, plan } = resolved;
        const hostname = new URL(row.baseUrl).hostname;
        const body = {
          ...entry,
          url: `http://${hostname}:${plan.port}`,
          // GET answers provider as a display STRING; the PUT model demands
          // {organization, url} with both required — rebuild the write shape
          // (live 422 finding in the drain drill). Same for version: stored
          // numerically, the card model wants its string.
          provider: { organization: "paas-pack", url: row.baseUrl },
          version: String(entry.version ?? "1"),
          metadata: {
            ...(entry.metadata ?? {}),
            runner_id: target.id,
            // A failover always recomputes placement — a stale override from
            // the dead runner's geometry never survives the move.
            ...(plan.override != null ? { port_override: plan.override } : {}),
          },
        };
        if (plan.override == null) delete body.metadata.port_override;
        try {
          await registry.putAgent(entry.path, body);
          occupied.set(plan.port, entry.path);
          entries = entries.map((e) => (e.path === entry.path ? body : e));
          moved += 1;
          log.log(`[fleet-scheduler] '${entry.path}' → ${target.id}:${plan.port}${plan.override != null ? ` (override ${plan.override})` : ""}`);
        } catch (e) {
          log.warn(`[fleet-scheduler] re-point '${entry.path}' failed: ${e?.message || e}`);
        }
      }
    }
    return { moved };
  }

  let timer = null;
  let running = false;
  function start() {
    if (timer) return;
    const intervalMs = config.intervalMs ?? 30_000;
    const pass = async () => {
      if (running) return;
      running = true;
      try {
        await tick();
      } catch (e) {
        log.warn(`[fleet-scheduler] pass error: ${e?.message || e}`);
      } finally {
        running = false;
      }
    };
    timer = setInterval(() => void pass(), intervalMs);
    timer.unref?.();
    void pass();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, pickPlacement, healthy, stale };
}
