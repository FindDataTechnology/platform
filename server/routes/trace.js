// Trace viewer endpoints: per-turn summaries + full event timelines for /trace.

import * as traceModule from "../trace.js";

export function registerTraceRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/trace/turns", (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
      res.json({ turns: traceModule.listTurns({ limit, offset, sessionId }) });
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
