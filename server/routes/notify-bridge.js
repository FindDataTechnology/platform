// ── Notify bridge routes, cell side (add-broadcast-and-notification-inbox 3.1–3.4) ─
//
// The loopback REST half of `server/notify-mcp.js`. Two verbs:
//
//   GET  /api/notify/inbox/:owner                    list that owner's notices
//   POST /api/notify/inbox/:owner/:id/act            run the notice's action
//
// The owner in the URL is NOT trusted on its own: the caller must be the cell's
// own stdio child (loopback + no proxied identity), which the auth gate
// establishes in `INTERNAL_BRIDGES` before this route runs. That is the same
// discipline the input-request bridge uses, and it is why the child's profile
// env — not the model — decides who "me" is.
//
// The act verb deliberately does NOT execute anything itself. It hands the
// notice's declared action to `lib/notification-action.js`, which routes it
// through the platform's action gate (registry, preflight, mandate, risk tier).
// A notice therefore cannot grant authority the caller did not already have; an
// above-read action comes back `pending` for the owner's approval.

import * as dbModule from "../../db.js";
import { shapeNotification } from "../../lib/broadcast-store.js";
import { runNotificationAction } from "../../lib/notification-action.js";

export function registerNotifyBridgeRoutes(app, ctx = {}) {
  const dbHandle = () => (dbModule.isDbReady() ? dbModule.getDb() : null);

  const ownerOf = (req) => String(req.params.owner ?? "").trim().toLowerCase();

  app.get("/api/notify/inbox/:owner", (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(400).json({ error: "owner is required" });
    const db = dbHandle();
    if (!db) return res.json({ notifications: [], unread: 0 });

    const qs = req.query;
    const source = typeof qs.source === "string" && qs.source.trim() ? qs.source.trim() : null;
    const state = typeof qs.state === "string" && qs.state.trim() ? qs.state.trim() : null;
    const limit = Math.min(Number(qs.limit) || 50, 200);
    try {
      const where = ["recipient_kind = 'user'", "recipient_id = ?"];
      const params = [owner];
      if (source) {
        where.push("source = ?");
        params.push(source);
      }
      // Default view is "not yet acted on": an acted notice is history, and a
      // tool that lists history by default would bury the work.
      if (state) {
        where.push("state = ?");
        params.push(state);
      } else {
        where.push("state <> 'acted'");
      }
      const rows = db
        .prepare(`SELECT * FROM notifications WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, limit);
      const unread =
        db
          .prepare(
            "SELECT count(*) AS c FROM notifications WHERE recipient_kind = 'user' AND recipient_id = ? AND state = 'unread'",
          )
          .get(owner)?.c ?? 0;
      res.set("Cache-Control", "no-store");
      res.json({ notifications: rows.map(shapeNotification), unread });
    } catch (err) {
      if (/no such table/i.test(String(err?.message ?? ""))) return res.json({ notifications: [], unread: 0 });
      console.error("[notify-bridge] list failed:", err?.message || err);
      res.status(500).json({ error: "inbox read failed" });
    }
  });

  app.post("/api/notify/inbox/:owner/:id/act", async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(400).json({ error: "owner is required" });
    const db = dbHandle();
    if (!db) return res.status(503).json({ error: "database unavailable" });

    let row;
    try {
      row = db
        .prepare("SELECT * FROM notifications WHERE id = ? AND recipient_kind = 'user' AND recipient_id = ?")
        .get(req.params.id, owner);
    } catch (err) {
      if (/no such table/i.test(String(err?.message || ""))) {
        return res.status(404).json({ error: "notification not found" });
      }
      return res.status(500).json({ error: "notification read failed" });
    }
    if (!row) return res.status(404).json({ error: "notification not found" });

    const notice = shapeNotification(row);
    if (!notice.action) {
      // A notice without an action is informational; answering 400 with the
      // reason is better than silently marking it acted.
      return res.status(400).json({ error: "this notification carries no action", code: "no_action" });
    }

    const outcome = await runNotificationAction({ action: notice.action, ownerEmail: owner, ctx });
    if (!outcome.ok) {
      // The gate's refusal is relayed verbatim: the model must be able to see
      // that it was the SAME check a direct call would have hit.
      return res.status(outcome.status).json(outcome.body);
    }
    // Only now is "acted" true. A proposal the owner still has to approve is
    // recorded as read-and-proposed, not acted — the distinction is what keeps
    // this state honest.
    const proposed = outcome.body?.state === "pending";
    db.prepare(
      `UPDATE notifications SET state = ?, acted_at = ?, acted_by = ?
        WHERE id = ? AND recipient_kind = 'user' AND recipient_id = ?`,
    ).run(proposed ? "read" : "acted", proposed ? null : new Date().toISOString(), owner, req.params.id, owner);
    res.json({ ok: true, proposed, gate: outcome.body });
  });
}
