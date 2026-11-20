// ── Cell fleet reporter (unify-wanxing-management-plane) ────────────────────
//
// The 萬星 management plane's short-term half, read-only by design D1/D2:
// sample every live cell's task-stats endpoint over the gateway's internal
// identity channel and relay one cell_stats event per cell per tick to the
// fleet ingest — the same observation plane runner heartbeats use. Management
// actions stay runner-side; nothing here can steer a cell, and cells hold no
// new credential (the gateway is the only one talking to the observer).
//   SECOND LANE (agent-fleet-cockpit-projection): a slower, separate tick
// samples each live cell's /api/fleets/overview and relays it verbatim as a
// `cell_fleets` event — the compact fleet mirror for the 萬星 ops board. Own
// interval + kill switch; identical fault model (log-only, no replay, live
// cells only — a sleeping cell simply reports nothing this tick).
//
// Deliberately NOT durable: cell_stats are periodic snapshots, not an event
// stream — a dropped tick reads as one sample late, which the board's window
// already tolerates, so there is no spool to replay. Every failure is
// log-only; the reporter must never tax request handling.

import { randomUUID } from "node:crypto";
import { GATEWAY_SECRET_HEADER } from "../server/auth.js";

const SAMPLE_TIMEOUT_MS = 2_000;
// The fleets lane's overview endpoint is HEAVY (one memberView per post per
// fleet — big owners hold 20 fleets and answer in 2.5s+). Stats needs a fast
// fail; the projection lane needs enough room to actually get one — its
// silence was the fleets-lane-never-emits defect (2026-10-27, measured: a
// 2579ms cell answer aborting against the shared 2000ms budget every tick).
const FLEETS_SAMPLE_TIMEOUT_MS = 10_000;

export function createCellFleetReporter({
  registry,
  secret,
  fetchImpl = fetch,
  env = process.env,
  log = (m) => console.log(m),
  now = Date.now,
  startImmediate = true,
}) {
  const baseUrl = String(env.FLEET_INGEST_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.FLEET_INGEST_TOKEN || "").trim();
  const intervalMs = Math.max(5, Number(env.FLEET_CELL_SAMPLE_SECS || 30)) * 1000;
  if (!baseUrl || !token) return null; // unconfigured = the reporter does not exist
  const fleetsIntervalMs = Math.max(5, Number(env.FLEET_CELL_FLEETS_SAMPLE_SECS || 60)) * 1000;
  const fleetsEnabled = String(env.FLEET_CELL_FLEETS_ENABLE ?? "1") !== "0";

  function liveCells() {
    const out = [];
    for (const [userId, cell] of registry.cells) {
      if (!cell || cell.state === "stopping" || !cell.port) continue;
      out.push([userId, cell]);
    }
    return out;
  }

  async function postIngest(events) {
    if (events.length === 0) return;
    try {
      const res = await fetchImpl(`${baseUrl}/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS * 5),
      });
      if (!res.ok) log(`[cell-fleet] ingest ${res.status} — dropping ${events.length} sample(s) this tick`);
    } catch (e) {
      log(`[cell-fleet] ingest failed: ${e?.message || e}`);
    }
  }

  async function sampleCell(forwardedIdentity, port, path, timeoutMs = SAMPLE_TIMEOUT_MS) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
        headers: {
          // The gateway's own forged-identity channel: owner identity plus
          // the shared secret cells require before trusting the headers.
          "x-forwarded-email": forwardedIdentity,
          [GATEWAY_SECRET_HEADER]: secret,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null; // dead or erroring cell → absence this tick
      const payload = await res.json();
      return payload && typeof payload === "object" ? payload : null;
    } catch { /* a cell that cannot answer reports nothing */ return null; }
  }

  async function tick() {
    const events = [];
    for (const [userId, cell] of liveCells()) {
      const payload = await sampleCell(userId, cell.port, "/api/tasks/stats");
      if (!payload) continue;
      events.push({
        id: randomUUID(),
        source: "cell-sampler",
        agent: `cell:${userId}`,
        kind: "cell_stats",
        ts: now(),
        payload,
      });
    }
    await postIngest(events);
  }

  // Projection lane (agent-fleet-cockpit-projection): relay each live cell's
  // fleet overview verbatim. The cell-side endpoint already bounds payload
  // (50 fleets cap, snipped text); nothing here truncates further.
  // IDENTITY SPLIT: the registry key is userIdFor(email) = a hex id, while
  // /api/fleets/overview gates on the OWNER EMAIL (cell users are single-
  // owner) — so this lane forwards cell.email (the stats lane's hex identity
  // would 403). The event agent keeps the hex userId so the two lanes join.
  async function tickFleets() {
    const events = [];
    for (const [userId, cell] of liveCells()) {
      const payload = await sampleCell(cell.email ?? userId, cell.port, "/api/fleets/overview", FLEETS_SAMPLE_TIMEOUT_MS);
      if (!payload) continue;
      events.push({
        id: randomUUID(),
        source: "cell-sampler",
        agent: `cell:${userId}`,
        kind: "cell_fleets",
        ts: now(),
        payload,
      });
    }
    await postIngest(events);
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  if (startImmediate) void tick(); // first sample without waiting out a full interval

  let fleetsTimer = null;
  if (fleetsEnabled) {
    fleetsTimer = setInterval(() => {
      void tickFleets();
    }, fleetsIntervalMs);
    fleetsTimer.unref?.();
    if (startImmediate) void tickFleets();
  }
  return {
    tick,
    tickFleets,
    stop: () => { clearInterval(timer); if (fleetsTimer) clearInterval(fleetsTimer); },
  };
}
