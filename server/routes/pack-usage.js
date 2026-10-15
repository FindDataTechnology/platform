// server/routes/pack-usage.js — ops-gated aggregate read (add-pack-usage-telemetry).
//
// The single read surface for the usage telemetry: the ops console (and any
// ops tooling) asks "which packs are actually used, by whom, how much" and
// gets the weekly-active answer directly. Fail-closed: without a configured
// PACK_USAGE_TOKEN the endpoint answers 503, and no credential ever reads data.

import { packUsageAggregate } from "../usage-telemetry.js";

export function registerPackUsageRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/ops/pack-usage", (req, res) => {
    const token = process.env.PACK_USAGE_TOKEN?.trim();
    if (!token) {
      return res.status(503).json({ error: "pack usage surface not configured on this deployment" });
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: "ops credential required" });
    }
    return res.json(packUsageAggregate(req.query.days));
  });
}
