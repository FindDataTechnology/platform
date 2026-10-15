// ── Cell fleet reporter (unify-wanxing-management-plane) ────────────────────
//
// The 萬星 management plane's short-term half, read-only by design D1/D2:
// sample every live cell's task-stats endpoint over the gateway's internal
// identity channel and relay one cell_stats event per cell per tick to the
// fleet ingest — the same observation plane runner heartbeats use. Management
// actions stay runner-side; nothing here can steer a cell, and cells hold no
// new credential (the gateway is the only one talking to the observer).
//
// Deliberately NOT durable: cell_stats are periodic snapshots, not an event
// stream — a dropped tick reads as one sample late, which the board's window
// already tolerates, so there is no spool to replay. Every failure is
// log-only; the reporter must never tax request handling.

import { randomUUID } from "node:crypto";
import { GATEWAY_SECRET_HEADER } from "../server/auth.js";

const SAMPLE_TIMEOUT_MS = 2_000;

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

  async function tick() {
    const events = [];
    for (const [userId, cell] of registry.cells) {
      if (!cell || cell.state === "stopping" || !cell.port) continue;
      try {
        const res = await fetchImpl(`http://127.0.0.1:${cell.port}/api/tasks/stats`, {
          headers: {
            // The gateway's own forged-identity channel: owner identity plus
            // the shared secret cells require before trusting the headers.
            "x-forwarded-email": userId,
            [GATEWAY_SECRET_HEADER]: secret,
          },
          signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
        });
        if (!res.ok) continue; // dead or erroring cell → absence this tick
        const payload = await res.json();
        if (!payload || typeof payload !== "object") continue;
        events.push({
          id: randomUUID(),
          source: "cell-sampler",
          agent: `cell:${userId}`,
          kind: "cell_stats",
          ts: now(),
          payload,
        });
      } catch { /* a cell that cannot answer reports nothing */ }
    }
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

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  if (startImmediate) void tick(); // first sample without waiting out a full interval
  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
