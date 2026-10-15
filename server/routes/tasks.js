// ── Task stats lane (unify-wanxing-management-plane) ─────────────────────────
//
// Read-only counts off the task engine for the fleet plane: the gateway's
// cell sampler calls this over its internal identity channel (standard cell
// auth via the forged identity headers — deliberately NOT loopback-exempt;
// /api/cron's exemption is a historical MCP-bridge seam this route does not
// share). Answers the engine's stats snapshot verbatim.

import { Router } from "express";
import { stats } from "../../task-engine.js";

export function registerTaskRoutes(ctx) {
  const router = Router();

  router.get("/stats", (_req, res) => {
    res.json(stats());
  });

  ctx.app.use("/api/tasks", router);
}
