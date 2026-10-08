// ── Cron REST bridge ─────────────────────────────────────────────────────────
//
// Thin HTTP surface over the in-process cron engine. Two consumers:
//   1. The in-cell cron MCP child (server/cron-mcp.js) — authenticated by the
//      loopback-only exemption in server/auth.js (it has no cookie/secret).
//   2. Clients MAY use it, but the specced client path is the WS `cron_*`
//      messages (server/ws.js) — this bridge exists because an out-of-process
//      MCP child cannot call the engine's in-memory functions directly, and
//      writing jobs.json from a child would race the parent's write chain.

import { Router } from "express";
import * as cron from "../../cron.js";

export function registerCronRoutes(ctx) {
  const app = ctx.app;
  const router = Router();

  router.get("/", (req, res) => {
    res.json({ jobs: cron.listJobs() });
  });

  router.post("/", async (req, res) => {
    try {
      const job = await cron.addJob({
        cron: req.body?.cron,
        when: req.body?.when,
        prompt: req.body?.prompt,
        // MCP-created jobs bind to the preset the agent is running under
        // (spec: agent-scheduling-tools); browser/WS callers pass their own.
        preset: req.body?.preset ?? (req.user?.internal ? ctx.currentPreset : undefined),
        tz: req.body?.tz,
        sessionTitle: req.body?.sessionTitle,
      });
      res.status(201).json({ job });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/:id/pause", async (req, res) => {
    res.json({ ok: await cron.pauseJob(req.params.id) });
  });

  router.post("/:id/resume", async (req, res) => {
    res.json({ ok: await cron.resumeJob(req.params.id) });
  });

  router.post("/:id/run", async (req, res) => {
    // runJobNow returns the engine's enqueue result; ok=false with a message
    // (paused/expired/queued-already) is a normal answer, not a server error.
    const r = await cron.runJobNow(req.params.id);
    res.json({ ok: r?.ok === true, ...(r?.state ? { state: r.state } : {}), ...(r?.error ? { message: r.error } : {}) });
  });

  router.delete("/:id", async (req, res) => {
    res.json({ ok: await cron.removeJob(req.params.id) });
  });

  app.use("/api/cron", router);
}
