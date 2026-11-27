// ── Duty ring: wake suspended on_demand cells at their due schedule ────────
// (add-cell-lifecycle 3.2, spec: 需求驱动的唤醒与挂起)
//
// The ring decides from persistence ONLY — the registry row (state/policy)
// and the cell's data-root cron-store jobs.json (lib/cell-lifecycle.js
// cronJobsDue, the same math the desktop steward runs). Zero probes, zero
// temporary spawns. Bounded concurrency and a per-cell failure cooldown keep
// a mass of simultaneously-due cells from stampeding a roll.

import path from "node:path";
import {
  cronJobsDue,
  cronJobsLatestFireAt,
  readCronJobs,
  cellJobsFile,
  ownerFromCellData,
} from "../lib/cell-lifecycle.js";

// A cell that never went through a traffic bind has no ownerEmail in the
// registry, and "bind once by traffic first" is a dead end for exactly the
// cells that only ever run schedules (2026-11-15: cell 420a3344's daily
// patrol sat dead for 21 days — the ring saw due work every minute and could
// not wake it). `ownerFromCellData` reads the cell's own owner-groups.json;
// spawnCell's bindRequested beat then writes the real owner_email, so the
// fallback is also the self-heal. Shared with the monitoring face
// (lib/cell-lifecycle.js) so "who owns this cell" has exactly one rule.
//
// When even that fails, the skip is a **recorded state**, not just a log line:
// bind_failure_count / last_bind_failure_json are the registry columns that
// make "this fleet will never wake" queryable (surface-unwakeable-suspended-cells
// 1.1/3.1).

export function createDutyRing({
  registryDb,           // gateway/cell-registry
  dataRoot,             // CELL_DATA_ROOT
  ensure,               // spawner.ensure — the one and only spawn door
  spawnGate = 4,
  wakeCooldownMs = 10 * 60 * 1000,
  tickMs = 60 * 1000,
  now = () => Date.now(),
  log = console,
}) {
  const lastWakeFailedAt = new Map(); // cellId → ms (cooldown gate)
  let timer = null;
  let spinning = false;

  async function tick() {
    if (spinning) return;
    spinning = true;
    try {
      const rows = registryDb.all();
      // Refresh persisted workload first: the ring's wakeDue reads
      // workload.nextDueAt *plus* the jobs-file truth — the registry value is
      // advisory state, the scan is the decision.
      let inFlight = 0;
      await Promise.all(rows.map(async (origRow) => {
        let row = origRow;
        if (row.state !== "suspended" || row.policy !== "on_demand") return;
        if (row.destroy) return; // tombstoned cells never wake
        const jobs = readCronJobs(cellJobsFile(path.join(dataRoot, row.cellId)));
        const latestFire = cronJobsLatestFireAt(jobs);
        const due = cronJobsDue(jobs, now());
        // Keep registry workload honest in the same pass (read-only decision).
        registryDb.put({
          ...row,
          workload: { ...(row.workload ?? {}), cronCount: jobs.filter((j) => j?.cron && !j?.paused).length, lastFireAt: latestFire },
          ...(latestFire ? { lastDutyRunAt: latestFire } : {}),
        });
        // The scan is the arbiter (spec: derived by reading persistence only).
        // Advisory workload.nextDueAt never overrides it.
        if (!due) return;
        const cooldownUntil = lastWakeFailedAt.get(row.cellId);
        if (cooldownUntil && now() < cooldownUntil) { log.log?.(`[duty-ring] ${row.cellId} in wake-failure cooldown`); return; }
        if (!row.ownerEmail) {
          const recovered = ownerFromCellData(dataRoot, row.cellId);
          if (!recovered) {
            log.warn?.(`[duty-ring] ${row.cellId} has due work but no ownerEmail on file — it must bind once by traffic first`);
            // Record the skip so "this cell can never wake" is queryable
            // instead of living only in a log line (spec: 跳过唤醒必须留下
            // 可查询的处置记录). Only reached when `due` — a cell with no work
            // is not unwakeable, it is idle, and recording those would turn
            // the counter into noise nobody can act on.
            try {
              registryDb.put({
                ...row,
                bindFailureCount: Number(row.bindFailureCount ?? 0) + 1,
                lastBindFailure: {
                  cellId: row.cellId,
                  phase: "wake",
                  reason: "no_owner_identity",
                  at: new Date(now()).toISOString(),
                  dueJobs: jobs.filter((j) => j?.cron && !j?.paused).length,
                },
              });
            } catch (e) {
              log.warn?.(`[duty-ring] ${row.cellId} could not record the unwakeable skip: ${e?.message || e}`);
            }
            return;
          }
          log.log?.(`[duty-ring] ${row.cellId} has no ownerEmail in the registry — falling back to the cell's own owner-groups.json (${recovered})`);
          row = { ...row, ownerEmail: recovered };
        }
        if (inFlight >= spawnGate) return;
        inFlight += 1;
        log.log?.(`[duty-ring] waking suspended cell ${row.cellId} (due schedule)`);
        try {
          await ensure({ email: row.ownerEmail });
          lastWakeFailedAt.delete(row.cellId);
          // Clear the record once the cell really woke: a stale "unwakeable"
          // counter on a cell that now runs would be the alert nobody trusts.
          if (row.bindFailureCount || row.lastBindFailure) {
            try {
              registryDb.put({ ...row, bindFailureCount: 0, lastBindFailure: null });
            } catch (e) {
              log.warn?.(`[duty-ring] ${row.cellId} woke but the unwakeable record did not clear: ${e?.message || e}`);
            }
          }
        } catch (e) {
          lastWakeFailedAt.set(row.cellId, now() + wakeCooldownMs);
          log.warn?.(`[duty-ring] wake failed for ${row.cellId}: ${e?.message || e} (cooldown ${Math.round(wakeCooldownMs / 60000)}min)`);
        }
      }));
    } finally {
      spinning = false;
    }
  }

  return {
    start() {
      timer = setInterval(() => void tick().catch((e) => log.warn?.(`[duty-ring] tick error: ${e?.message || e}`)), tickMs);
      timer.unref?.();
      void tick().catch(() => {});
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
  };
}
