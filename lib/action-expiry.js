// ── Action expiry sweeper (add-line-boards-and-action-gate, task 1.4) ───────
//
// Scans pending proposals older than 24h and marks them expired (fail-closed).
// Broadcasts {type:"action_expired", proposalId} for each expiring row.
// Runs every 60s; unref'd so it doesn't block shutdown.

import { getDb } from "../db.js";

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Start the expiry job. Call once in server startup.
 */
export function startActionExpiryJob(ctx) {
  const { broadcast } = ctx; // expect: { type:"action_expired", proposalId }
  setInterval(() => {
    try {
      const db = getDb();
      if (!db || !broadcast) return;

      // created_at is stored as ISO TEXT — the threshold MUST be the same
      // shape. A numeric epoch here silently matches nothing (SQLite orders
      // any TEXT above any INTEGER), which is exactly the bug the live
      // acceptance probe caught (2026-10-20): the sweeper ran but never fired.
      const threshold = new Date(Date.now() - EXPIRY_MS).toISOString();
      const now = new Date().toISOString();
      const rows = db.prepare(`
        SELECT proposal_id FROM action_proposals
        WHERE state = 'pending' AND created_at <= ?
      `).all(threshold);

      if (!rows.length) return;

      const update = db.prepare(`
        UPDATE action_proposals SET state = 'expired', expired_at = ?, updated_at = ?
        WHERE state = 'pending' AND created_at <= ?
      `);

      for (const r of rows) {
        update.run(now, now, threshold);
        console.log(`[actions] Expired proposal ${r.proposal_id} (pending >24h)`);
        broadcast({ type: "action_expired", proposalId: r.proposal_id });
      }
    } catch (err) {
      console.error("[actions/expiry] sweep failed:", err.message);
    }
  }, 60 * 1000).unref();
}
