// server/routes/pack-usage.js — ops-gated aggregate read (add-pack-usage-telemetry).
//
// The single read surface for the usage telemetry: the ops console (and any
// ops tooling) asks "which packs are actually used, by whom, how much" and
// gets the weekly-active answer directly. Fail-closed: without a configured
// PACK_USAGE_TOKEN the endpoint answers 503, and no credential ever reads data.
//
// The bearer is compared through `secretMatches` — the shared constant-time
// compare. The gate exempts `/api/ops/` because this route authenticates
// itself; a plain `!==` here would be the only secret comparison on the
// platform that leaks a byte-by-byte timing signal.

import { secretMatches } from "../auth.js";
import { packUsageAggregate } from "../usage-telemetry.js";

const bearerOf = (header) => {
  const raw = String(header || "");
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
};

export function registerPackUsageRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/ops/pack-usage", (req, res) => {
    const token = process.env.PACK_USAGE_TOKEN?.trim();
    if (!token) {
      return res.status(503).json({ error: "pack usage surface not configured on this deployment" });
    }
    if (!secretMatches(bearerOf(req.headers.authorization), token)) {
      return res.status(401).json({ error: "ops credential required" });
    }
    return res.json(packUsageAggregate(req.query.days));
  });
}
