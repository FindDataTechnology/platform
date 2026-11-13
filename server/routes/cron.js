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
import { getClusterDatabase } from "./clusters-db.js";

export function registerCronRoutes(ctx) {
  const app = ctx.app;
  const router = Router();

  router.get("/", (req, res) => {
    // projectId query (add-web-project-container): absent = every job (default
    // view, unchanged); "default" = the unattributed (默认项目) bucket; an id =
    // that project's jobs. The engine never reads projectId — filtering is a
    // read-surface concern, same as sourceTag.
    const q = req.query?.projectId;
    const jobs = cron.listJobs();
    const filtered =
      q === undefined ? jobs : jobs.filter((j) => (q === "default" ? !j.projectId : j.projectId === String(q)));
    res.json({ jobs: filtered });
  });

  router.post("/", async (req, res) => {
    try {
      // Cluster binding (agent-cluster-platform): resolve the cluster ref HERE
      // — the route owns clusters.db. addJob validates the policy shapes; this
      // side guarantees the target exists and stamps the human label/count the
      // list views and the cron MCP read off the record.
      let clusterFields = null;
      const clusterId = req.body?.clusterId;
      if (clusterId !== undefined) {
        if (typeof clusterId !== "string" || !clusterId.trim()) {
          return res.status(400).json({ error: "clusterId must be a non-empty string" });
        }
        const cluster = getClusterDatabase().get(clusterId);
        if (!cluster) {
          return res.status(400).json({ error: `cluster '${clusterId}' not found` });
        }
        clusterFields = {
          clusterId: cluster.id,
          clusterName: cluster.name,
          agentCount: cluster.agents.length,
          executionPolicy: req.body?.executionPolicy,
          targetAgents: req.body?.targetAgents,
        };
      }
      const job = await cron.addJob({
        cron: req.body?.cron,
        when: req.body?.when,
        prompt: req.body?.prompt,
        // MCP-created jobs bind to the preset the agent is running under
        // (spec: agent-scheduling-tools); browser/WS callers pass their own.
        // A cluster task's target IS the cluster — the internal-preset
        // fallback must not ride along (addJob rejects preset+clusterId).
        preset: clusterFields ? undefined : (req.body?.preset ?? (req.user?.internal ? ctx.currentPreset : undefined)),
        tz: req.body?.tz,
        sessionTitle: req.body?.sessionTitle,
        // Project attribution (add-web-project-container): the active web
        // project the client is creating this job under, if any. NULL/absent
        // leaves the job in the 默认项目 bucket.
        projectId: req.body?.projectId ?? null,
        ...(clusterFields ?? {}),
      });
      res.status(201).json({ job });
    } catch (err) {
      // Cold-cell boot race: the engine is not wired yet — tell the caller to
      // retry rather than report a validation failure.
      const starting = /still starting/.test(err.message);
      res.status(starting ? 503 : 400).json({ error: err.message });
    }
  });

  router.post("/:id/pause", async (req, res) => {
    res.json({ ok: await cron.pauseJob(req.params.id) });
  });

  // In-place edit (add-cron-automation-parity 2.1): id, execution history and
  // paused state survive; only the provided fields change.
  router.patch("/:id", async (req, res) => {
    try {
      const job = await cron.updateJob(req.params.id, req.body ?? {});
      if (!job) return res.status(404).json({ error: `task ${req.params.id} not found` });
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/:id/resume", async (req, res) => {
    res.json({ ok: await cron.resumeJob(req.params.id) });
  });

  router.post("/:id/run", async (req, res) => {
    // runJobNow returns the engine's enqueue result; ok=false with a message
    // (paused/expired/queued-already) is a normal answer, not a server error.
    // `already` + `queuedForMs` ride through verbatim (fix-task-queue-deadlock
    // D4): a repeat ignition must be distinguishable from a fresh one, or a
    // wedged queue reads exactly like a healthy one.
    const r = await cron.runJobNow(req.params.id);
    res.json({
      ok: r?.ok === true,
      ...(r?.state ? { state: r.state } : {}),
      ...(r?.already ? { already: true } : {}),
      ...(typeof r?.queuedForMs === "number" ? { queuedForMs: r.queuedForMs } : {}),
      ...(r?.error ? { message: r.error } : {}),
    });
  });

  router.delete("/:id", async (req, res) => {
    res.json({ ok: await cron.removeJob(req.params.id) });
  });

  app.use("/api/cron", router);
}
