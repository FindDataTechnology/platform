// ── Duty ring: wake suspended on_demand cells at their due schedule ────────
// (add-cell-lifecycle 3.2, spec: 需求驱动的唤醒与挂起)
//
// The ring decides from persistence ONLY — the registry row (state/policy)
// and the cell's data-root cron-store jobs.json (lib/cell-lifecycle.js
// cronJobsDue, the same math the desktop steward runs). Zero probes, zero
// temporary spawns. Bounded concurrency and a per-cell failure cooldown keep
// a mass of simultaneously-due cells from stampeding a roll.

import path from "node:path";
import { cronJobsDue, cronJobsLatestFireAt, readCronJobs, cellJobsFile } from "../lib/cell-lifecycle.js";

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
      await Promise.all(rows.map(async (row) => {
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
          log.warn?.(`[duty-ring] ${row.cellId} has due work but no ownerEmail on file — it must bind once by traffic first`);
          return;
        }
        if (inFlight >= spawnGate) return;
        inFlight += 1;
        log.log?.(`[duty-ring] waking suspended cell ${row.cellId} (due schedule)`);
        try {
          await ensure({ email: row.ownerEmail });
          lastWakeFailedAt.delete(row.cellId);
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
