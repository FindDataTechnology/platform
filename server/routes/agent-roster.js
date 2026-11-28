// Agent roster management API (add-agent-roster-management).
//
// GET  /api/agent/hidden — the requester's hidden-role set (catalog ids).
// PUT  /api/agent/hidden — stores the COMPLETE desired set (idempotent; a
//                          delta would let a retried/multi-tab write land a
//                          state nobody asked for), then broadcasts
//                          catalog_changed so every view refetches.
// GET  /api/agent/usage  — per-agent turn counts for the requester, so a
//                          deployer can answer "do I actually use this role?"
//                          without the ops credential.
//
// Auth: the standard HTTP identity gate (server/auth.js) answers 401 for
// /api/* when auth is enabled, before these run; with auth off the requester
// IS the machine owner — the same semantics overlay.js and the catalog's role
// visibility take. `local` is the runtime carrier, not a partner: it can never
// be hidden, and that is refused here rather than only hidden in the UI.

import { getHiddenAgents, setHiddenAgents } from "../../db.js";
import { agentUsageAggregate } from "../usage-telemetry.js";
import { listAgents } from "../../catalog.js";

// The built-in local agent (catalog.js BUILT_IN) — the session itself.
const UNHIDEABLE = new Set(["local"]);

// Resolve the stored ids against the UNFILTERED merged catalog so the hidden
// section can name a role it no longer serves in the requester view, and can
// say honestly that an id belongs to nothing anymore (a departed pack role).
// This reads the same merged list dispatch uses — display-only, never a filter.
function resolveHidden(ids) {
  const byId = new Map(listAgents().map((e) => [e.id, e]));
  return ids.map((id) => {
    const e = byId.get(id);
    if (!e) return { id, name: null, source: null, known: false };
    return {
      id,
      name: e.name || id,
      source: e.customPreset ? "custom" : e.packId ? "pack" : e.type === "agent-local" ? "local" : "catalog",
      packName: e.packName ?? null,
      known: true,
    };
  });
}

export function registerAgentRosterRoutes(ctx) {
  const { app, broadcast } = ctx;

  app.get("/api/agent/hidden", (_req, res) => {
    res.json({ hidden: getHiddenAgents(), entries: resolveHidden(getHiddenAgents()) });
  });

  app.put("/api/agent/hidden", (req, res) => {
    const raw = req.body?.hidden;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "hidden must be an array of catalog entry ids" });
    }
    for (const id of raw) {
      if (typeof id !== "string" || !id.trim()) {
        return res.status(400).json({ error: "hidden must contain non-empty strings" });
      }
    }
    const blocked = raw.filter((id) => UNHIDEABLE.has(id));
    if (blocked.length) {
      return res.status(400).json({
        error: `the built-in agent cannot be hidden (${blocked.join(", ")}) — it is the runtime itself, not a role`,
      });
    }
    const stored = setHiddenAgents(raw);
    // A hide changes the requester-facing catalog; tell clients to refetch.
    broadcast({ type: "catalog_changed" });
    res.json({ hidden: stored, entries: resolveHidden(stored) });
  });

  app.get("/api/agent/usage", (req, res) => {
    // auth-on + no identity is already 401'd upstream; this is the defensive
    // second gate for a deployment whose gate exempts the path.
    if (ctx.authEnabled && !req.user?.email) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const ownerEmail = ctx.authEnabled ? req.user.email : null;
      res.json(agentUsageAggregate({ days: req.query.days, ownerEmail }));
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });
}