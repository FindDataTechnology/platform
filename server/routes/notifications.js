// ── Notification routes, cell side (add-broadcast-and-notification-inbox 2.5) ─
//
// Two faces over the cell's own `notifications` table:
//
//   GET  /api/notifications            this user's rows (the standalone read;
//                                      /api/inbox's notification lane is the
//                                      aggregate one and needs nothing here)
//   POST /api/notifications/:id/read   mark read — the inbox lane's declared
//                                      action points here
//
// Both are strictly owner-scoped: the recipient is the authenticated identity,
// never a query parameter. A notification id belonging to someone else answers
// 404 rather than 403, so an id cannot be probed for existence.

import * as dbModule from "../../db.js";
import { syncBroadcastReadToGateway } from "../notifications-sync.js";

export function registerNotificationRoutes(app, ctx = {}) {
  const resolveUser = (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });

  // The raw handle: `ctx.db` is the db MODULE (a function namespace), so it has
  // no .prepare. Null when the database failed to open.
  const dbHandle = () => (dbModule.isDbReady() ? dbModule.getDb() : null);

  // Reverse read-state sync (sync-broadcast-read-both-ways). Called AFTER the
  // cell's own write committed, and never awaited: the user's read is done, and
  // a gateway that is down must not turn it into a failed request. A row with no
  // broadcastId (handoff / task / system notices) has no second face.
  const syncToIm = (email, broadcastId) => {
    if (!broadcastId) return;
    void syncBroadcastReadToGateway({ email, broadcastId }).catch((err) =>
      console.warn(`[notifications] read-sync to gateway failed for ${email}: ${err?.message || err}`),
    );
  };

  app.get("/api/notifications", (req, res) => {
    const user = resolveUser(req);
    if (!user?.email) return res.status(401).json({ error: "Authentication required" });
    const db = dbHandle();
    if (!db) return res.json({ v: 1, notifications: [], unread: 0 });

    const email = String(user.email).trim().toLowerCase();
    const state = typeof req.query.state === "string" && req.query.state.trim() ? req.query.state.trim() : null;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    try {
      const rows = state
        ? db
            .prepare(
              `SELECT * FROM notifications WHERE recipient_kind = 'user' AND recipient_id = ? AND state = ?
                 ORDER BY created_at DESC LIMIT ?`,
            )
            .all(email, state, limit)
        : db
            .prepare(
              `SELECT * FROM notifications WHERE recipient_kind = 'user' AND recipient_id = ?
                 ORDER BY created_at DESC LIMIT ?`,
            )
            .all(email, limit);
      const unread = db
        .prepare(
          "SELECT count(*) AS c FROM notifications WHERE recipient_kind = 'user' AND recipient_id = ? AND state = 'unread'",
        )
        .get(email)?.c ?? 0;
      res.set("Cache-Control", "no-store");
      res.json({
        v: 1,
        notifications: rows.map((row) => ({
          id: row.id,
          broadcastId: row.broadcast_id ?? null,
          source: row.source,
          title: row.title,
          body: row.body,
          ref: safeParse(row.ref_json),
          action: safeParse(row.action_json),
          state: row.state,
          createdAt: row.created_at,
          actedAt: row.acted_at ?? null,
        })),
        unread,
      });
    } catch (err) {
      // Pre-migration cell: an empty inbox is the truth, not a 500.
      if (/no such table/i.test(String(err?.message ?? ""))) return res.json({ v: 1, notifications: [], unread: 0 });
      console.error("[notifications] read failed:", err?.message || err);
      res.status(500).json({ error: "notification read failed" });
    }
  });

  // Gateway → cell read-state sync (sync-broadcast-read-state).
  //
  // The gateway owns the zhiyu IM face; this cell owns the aggregate inbox.
  // When a broadcast notice is read over there, the caller names BOTH halves of
  // the row's identity — the broadcast and the recipient — never a cell-internal
  // notification id it could not know. Channel-only: the gateway presents the
  // shared secret (INTERNAL_BRIDGES), and the recipient is the one the gateway
  // already authenticated.
  app.post("/api/notifications/read-by-broadcast", (req, res) => {
    const db = dbHandle();
    if (!db) return res.status(503).json({ error: "database unavailable" });
    const recipient = String(req.body?.recipient ?? "").trim().toLowerCase();
    const broadcastId = String(req.body?.broadcastId ?? "").trim();
    if (!recipient || !broadcastId) {
      return res.status(400).json({ error: "recipient and broadcastId are required" });
    }
    try {
      const r = db
        .prepare(
          `UPDATE notifications SET state = 'read'
            WHERE broadcast_id = ? AND recipient_kind = 'user' AND recipient_id = ? AND state = 'unread'`,
        )
        .run(broadcastId, recipient);
      // NO bounce-back here on purpose: this route IS the gateway's own sync
      // arriving. Syncing it straight back would be redundant at best and a loop
      // between two live faces at worst. The originating side already knows —
      // it made the call.
      res.json({ ok: true, changed: r.changes });
    } catch (err) {
      if (/no such table/i.test(String(err?.message ?? ""))) return res.json({ ok: true, changed: 0 });
      console.error("[notifications] broadcast read-sync failed:", err?.message || err);
      res.status(500).json({ error: "read sync failed" });
    }
  });

  app.post("/api/notifications/:id/read", (req, res) => {
    const user = resolveUser(req);
    if (!user?.email) return res.status(401).json({ error: "Authentication required" });
    const db = dbHandle();
    if (!db) return res.status(404).json({ error: "notification not found" });
    const email = String(user.email).trim().toLowerCase();
    try {
      // The recipient predicate is IN the UPDATE: an id owned by someone else
      // changes nothing, so the answer is the same 404 as a nonexistent one.
      const r = db
        .prepare(
          `UPDATE notifications SET state = 'read'
            WHERE id = ? AND recipient_kind = 'user' AND recipient_id = ? AND state = 'unread'`,
        )
        .run(req.params.id, email);
      if (r.changes === 0) {
        const exists = db
          .prepare(
            "SELECT 1 AS x FROM notifications WHERE id = ? AND recipient_kind = 'user' AND recipient_id = ?",
          )
          .get(req.params.id, email);
        if (!exists) return res.status(404).json({ error: "notification not found" });
        return res.json({ ok: true, changed: false }); // already read
      }
      // The user read it HERE, so the IM face must learn it (sync-broadcast-read-
      // both-ways). Read the broadcastId that was just settled — the UPDATE ran
      // first, so this is the row it touched.
      const settled = db
        .prepare("SELECT broadcast_id FROM notifications WHERE id = ? AND recipient_id = ?")
        .get(req.params.id, email);
      syncToIm(email, settled?.broadcast_id);
      res.json({ ok: true, changed: true });
    } catch (err) {
      if (/no such table/i.test(String(err?.message ?? ""))) {
        return res.status(404).json({ error: "notification not found" });
      }
      console.error("[notifications] mark-read failed:", err?.message || err);
      res.status(500).json({ error: "mark read failed" });
    }
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
