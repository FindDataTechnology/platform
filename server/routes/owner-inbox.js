// ── Owner inbox route (openspec: owner-inbox) ────────────────────────────────
//
// One read-only endpoint. Every lane it fans out to is an existing read path;
// the inbox adds no writes, no state machine, and no second source of truth.
// Actions ride back as DATA (each names its lane's own existing endpoint), so
// the client dispatches with a plain http() call and no lane logic exists here.

import { buildInbox, LANE_IDS } from "../owner-inbox.js";

export function registerOwnerInboxRoutes(app, ctx = {}) {
  const resolveUser = (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });

  app.get("/api/inbox", (req, res) => {
    const user = resolveUser(req);
    if (!user?.email) return res.status(401).json({ error: "Authentication required" });
    // `?lanes=a,b` narrows the fan-out; an unknown id is answered inside
    // buildInbox as a structured per-lane error rather than a 400, so one
    // typo cannot blank the whole surface.
    const lanes = typeof req.query.lanes === "string" && req.query.lanes.trim()
      ? req.query.lanes.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    try {
      res.set("Cache-Control", "no-store");
      res.json(buildInbox({ email: user.email }, { lanes }));
    } catch (err) {
      // buildInbox isolates lane failures itself; reaching here means the
      // envelope broke, which is a genuine 500.
      console.error("[owner-inbox] build failed:", err?.message || err);
      res.status(500).json({ error: "inbox build failed" });
    }
  });

  // The lane roster is public metadata (ids + labels), not per-user data —
  // clients use it to render an empty "all lanes" frame before the first read.
  app.get("/api/inbox/lanes", (_req, res) => {
    res.json({ v: 1, lanes: [...LANE_IDS] });
  });
}
