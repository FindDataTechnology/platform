// ── Residency policy engine (add-cell-lifecycle, chapter 2) ────────────────
//
// Executes the cell's residency policy against the SAME persistence the cloud
// duty ring reads (spec: the wake decision never probes a process):
//   always      supervisor stack stays up whenever the steward is alive.
//   on_demand   scan <dataDir>/data/cron-store/jobs.json each duty tick;
//               any enabled round due ({nextRun|cron-due-after-lastRun} ≤ now)
//               starts the stack; after `quietMs` with no fresh round AND no
//               control-plane activity, the stack drains again.
//   manual      the engine never starts anything (embedded world).
//
// Timers are re-armed from disk state every tick — a crash only ever costs
// one scan cycle's worth of wake latency, never a missed schedule (the
// cell's own catch-up covers the gap at stack start).

import fs from "node:fs";
import path from "node:path";
import cronParser from "cron-parser";

const JOBS_REL = path.join("data", "cron-store", "jobs.json");

export function createPolicyEngine({
  supervisor,
  steward,
  dataDir,
  quietMs = 15 * 60 * 1000,
  tickMs = 60 * 1000,
  now = () => Date.now(),
}) {
  const jobsFile = path.join(dataDir, JOBS_REL);
  let policy = steward.policy ?? "manual";
  let timer = null;
  let lastClientAt = null;
  let running = steward.running ?? false;

  function readJobs() {
    try {
      const rows = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  // Newest evidence of activity: lastRun of any enabled cron row. Absent when
  // nothing ever ran — sober input to both wake and drain decisions.
  function latestFireAt(jobs) {
    let latest = null;
    for (const j of jobs) {
      const t = j?.lastRun ? Date.parse(j.lastRun) : null;
      if (Number.isFinite(t) && (latest == null || t > latest)) latest = t;
    }
    return latest;
  }

  // Next due moment across enabled rows. Parses cron+tz from the persisted
  // record itself — no engine, no process, no probe (spec-canon).
  function _nextDueAt(jobs, fromMs) {
    let next = null;
    for (const j of jobs) {
      if (j?.paused || !j?.cron || j?.type !== "recurring") continue;
      try {
        const iter = cronParser.parseExpression(j.cron, { tz: j.tz || undefined, currentDate: new Date(fromMs) });
        const at = iter.next().toDate().getTime();
        if (Number.isFinite(at) && (next == null || at < next)) next = at;
      } catch { /* unparseable rows are the engine's problem, not the ring's */ }
    }
    return next;
  }

  // Due-now predicate: an enabled row whose persisted schedule had an
  // occurrence since its own lastRun (or since materialization when never
  // run). The cell's catch-up decides which occurrence(s) to make up — the
  // engine only has to wake the cell.
  function dueNow(jobs, fromMs) {
    for (const j of jobs) {
      if (j?.paused || !j?.cron || j?.type !== "recurring") continue;
      try {
        const anchor = j.lastRun ? Date.parse(j.lastRun) : (j.createdAt ? Date.parse(j.createdAt) : null);
        if (anchor == null || !Number.isFinite(anchor)) continue;
        const iter = cronParser.parseExpression(j.cron, { tz: j.tz || undefined, currentDate: new Date(anchor) });
        const occ = iter.next().toDate().getTime();
        if (occ <= fromMs) return true;
      } catch { /* skip */ }
    }
    return false;
  }

  async function tick() {
    if (policy === "manual") return;
    const jobs = readJobs();
    const latest = latestFireAt(jobs);
    if (policy === "on_demand") {
      if (!running) {
        if (dueNow(jobs, now())) {
          await supervisor.start().catch(() => {});
          running = true;
          steward.running = true;
        }
      } else {
        const quietSinceClient = lastClientAt == null || now() - lastClientAt >= quietMs;
        const quietSinceFire = latest == null || now() - latest >= quietMs;
        if (quietSinceClient && quietSinceFire) {
          await supervisor.stop().catch(() => {});
          running = false;
          steward.running = false;
        }
      }
    } else if (policy === "always" && !running) {
      await supervisor.start().catch(() => {});
      running = true;
      steward.running = true;
    }
  }

  function start() {
    timer = setInterval(() => void tick(), tickMs);
    timer.unref?.();
    void tick();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function reload(nextPolicy) { policy = nextPolicy; void tick(); }
  function noteActivity() { lastClientAt = now(); }

  return { start, stop, reload, noteActivity, tick, get policy() { return policy; } };
}
