// Trace viewer endpoints: per-turn summaries + full event timelines for /trace.

import * as traceModule from "../trace.js";
import { getFleetDatabase } from "./fleets-db.js";

// Fleet attribution (add-cockpit-ux-polish / agent-fleet-runs): page turns
// whose ids hit the run ledger's trace keys get their post named and a link
// target; everything else stays unannotated (web turns, pruned keys). Pure —
// exported for tests.
export function annotateFleetTurns(turns, rows) {
  const byKey = new Map(rows.map((r) => [r.trace_turn_id, r]));
  return turns.map((t) => {
    const hit = byKey.get(t.turnId);
    return hit
      ? { ...t, fleet: { fleetId: hit.fleet_id, memberId: hit.member_id, memberTitle: hit.member_title ?? null } }
      : t;
  });
}

export function registerTraceRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/trace/turns", (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
      const turns = traceModule.listTurns({ limit, offset, sessionId });
      // One batched lookup for the page — the ledger is in the same process.
      let annotated = turns;
      try {
        const db = getFleetDatabase();
        const ids = turns.map((t) => t.turnId);
        const rows = ids.length
          ? db.db
              .prepare(`
                SELECT e.trace_turn_id, e.fleet_id, e.member_id, m.title AS member_title
                FROM member_turn_events e
                LEFT JOIN fleet_members m ON m.id = e.member_id
                WHERE e.trace_turn_id IN (${ids.map(() => "?").join(",")})
              `)
              .all(...ids)
          : [];
        annotated = annotateFleetTurns(turns, rows);
      } catch (e) {
        console.warn(`[trace] fleet annotation skipped: ${e?.message || e}`);
      }
      res.json({ turns: annotated });
    } catch (err) {
      console.error("[trace] list error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/trace/turns/:id", (req, res) => {
    try {
      const events = traceModule.getTurn(req.params.id);
      if (!events) return res.status(404).json({ error: "turn not found" });
      res.json({ turnId: req.params.id, events });
    } catch (err) {
      console.error("[trace] get error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
