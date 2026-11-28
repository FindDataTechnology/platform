// ── Broadcast routes, gateway side (add-broadcast-and-notification-inbox 1.5/2.1) ─
//
// Three faces, two audiences:
//
//   POST /api/broadcast                 ADMIN (browser session)       record + return reach
//   GET  /api/broadcast/pending?since=  MACHINE (gateway secret, cell) pull
//   POST /api/broadcast/:id/receipt     MACHINE (gateway secret, cell) report delivery
//
// Why the split: issuing is a deployment-wide administrative act and must be
// gated on a real admin identity. Pulling and reporting are done by every cell
// on a timer, which has no browser session — it presents the shared gateway
// secret, exactly like /api/roles/self. A cell can therefore never issue a
// broadcast, only consume from one.
//
// The pull endpoint returns the broadcast row AS RECORDED (audience selector,
// not expanded list). Each node re-expands nothing — it receives the recipient
// list in the row's `recipients` field, which the issuer resolved once. That
// keeps the identity authority in one place: nodes cannot disagree about who an
// org contains.

import express from "express";
import { broadcastErrorStatus, parseBroadcastBody } from "./broadcast-center.js";
import { GATEWAY_SECRET_HEADER } from "../server/auth.js";
import { cellDoorAuthorized } from "./cell-credential.js";

export function registerBroadcastRoutes(app, { center, isAdminUser, resolveUser, rejectUnauthenticated, secret, imInbox = null }) {
  // An unavailable ledger must not look like an admin-permission problem: 503
  // with the reason, before any identity work.
  const guard = (res) => {
    if (center) return true;
    res.status(503).json({ error: "broadcast is not available on this deployment" });
    return false;
  };

  app.post("/api/broadcast", express.json(), async (req, res) => {
    if (!guard(res)) return;
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });

    const parsed = parseBroadcastBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let resolved;
    try {
      resolved = await center.resolveAudience(parsed.audience);
    } catch (err) {
      // Every refusal reason (unknown kind, bad selector, zero hits, identity
      // source down) is a REFUSAL with its own status — never a broadcast.
      if (err?.name === "AudienceError") {
        return res.status(broadcastErrorStatus(err.code)).json({ error: err.message, code: err.code });
      }
      console.error("[broadcast] audience resolution failed:", err?.message || err);
      return res.status(500).json({ error: "audience resolution failed" });
    }

    // The resolved recipient list is stored WITH the row: each node receives
    // the list, never the selector, so no two nodes can disagree about who an
    // org contains (the identity authority answered exactly once).
    const record = center.ledger.recordBroadcast({
      actor: user.email,
      audience: parsed.audience,
      title: parsed.title,
      body: parsed.body,
      hitCount: resolved.recipients.length,
      recipients: resolved.recipients,
      wake: parsed.wake,
    });

    // The IM face (broadcast-reaches-zhiyu). Deliberately AFTER the ledger row:
    // the broadcast is recorded whether or not any IM delivery lands, and a
    // recipient whose IM write fails still gets their inbox row from the pull
    // lane. Failures are counted per recipient, never fatal to the request.
    const im = { sent: 0, failed: 0 };
    if (typeof imInbox === "function") {
      for (const email of resolved.recipients) {
        try {
          const r = await imInbox({
            email,
            broadcast: { id: record.id, seq: record.seq, title: parsed.title, body: parsed.body, action: parsed.action ?? null },
          });
          if (r?.sent) im.sent += 1;
          else im.failed += 1;
        } catch (err) {
          // One recipient's IM failure is that recipient's result. The rest of
          // the audience, and the whole inbox lane, are unaffected.
          console.warn(`[broadcast] im delivery to ${email} failed: ${err?.message || err}`);
          im.failed += 1;
        }
      }
    }

    // Honest counters: nothing is delivered until a node reports it (design D3).
    res.status(201).json({
      id: record.id,
      seq: record.seq,
      audience: parsed.audience,
      audienceLabel: center.describeAudience(parsed.audience),
      hitCount: resolved.recipients.length,
      okCount: 0,
      failCount: 0,
      wake: parsed.wake,
      ...(im.sent || im.failed ? { im } : {}),
    });
  });

  // ── Machine faces ────────────────────────────────────────────────────────
  const machine = (req, res) => {
    if (!cellDoorAuthorized(req.headers[GATEWAY_SECRET_HEADER], secret)) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return String(req.query.cell || req.body?.cellId || "").trim() || null;
  };

  app.get("/api/broadcast/pending", (req, res) => {
    if (!guard(res)) return;
    if (!machine(req, res)) return undefined;
    res.set("Cache-Control", "no-store");
    res.json({ broadcasts: center.pendingSince(req.query.since, req.query.limit) });
  });

  app.post("/api/broadcast/:id/receipt", express.json(), (req, res) => {
    if (!guard(res)) return;
    const cellId = machine(req, res);
    if (!cellId) return res.status(400).json({ error: "cell id is required" });
    const result = center.ledger.recordReceipt({
      broadcastId: req.params.id,
      cellId,
      ok: req.body?.ok,
      fail: req.body?.fail,
    });
    if (!result.applied) return res.status(404).json({ error: "unknown broadcast" });
    res.json(result);
  });
}
