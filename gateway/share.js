// ── Share-token registry (openspec: add-session-share) ──────────────────────
//
// The gateway's own small persistence surface backing session shares: an
// opaque token maps to an owner identity + session id, so a recipient can
// read one session without an account while everything else stays behind
// auth. Rows live in a dedicated SQLite file at the gateway data root —
// separate from every cell's DB, because the whole point is that a read
// resolves its owner's cell on demand (a reaped demo cell included) instead
// of living inside one.
//
// Groups are stored and replayed on reads: the spawner keys demo-cell bounds
// off `groups.includes("demo")`, so an owner's share must re-enter the
// registry with the identity it was created under, not a normalized one.
//
// Tokens are 24-char base64url of 18 random bytes (144 bits): unguessable,
// and carrying no structure — owner/session live only in the row, so a
// leaked token reveals nothing about either until it is redeemed.

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function createShareRegistry({ file }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS shares (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    groups TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  )`);

  const mintToken = () => randomBytes(18).toString("base64url");
  const now = () => Date.now();

  return {
    create({ email, groups = [], sessionId, title = "", expiresAt = null }) {
      const token = mintToken();
      db.prepare(
        `INSERT INTO shares (token, email, groups, session_id, title, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(token, email, groups.join(","), sessionId, title, now(), expiresAt);
      return token;
    },

    get(token) {
      return db.prepare(`SELECT * FROM shares WHERE token = ?`).get(token) ?? null;
    },

    // The owner's active shares (revoked and expired rows are invisible).
    listOwn(email) {
      return db
        .prepare(
          `SELECT token, session_id AS sessionId, title, created_at AS createdAt, expires_at AS expiresAt
           FROM shares
           WHERE email = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at DESC`,
        )
        .all(email, now());
    },

    // Ownership-checked soft delete. Returns false when the token does not
    // exist, belongs to someone else, or is already revoked — one answer for
    // all three, so probing revocations teaches nothing.
    revoke(email, token) {
      const r = db
        .prepare(`UPDATE shares SET revoked = 1 WHERE token = ? AND email = ? AND revoked = 0`)
        .run(token, email);
      return r.changes > 0;
    },

    // A share is redeemable only while live; callers render the same
    // not-available response for every false case.
    live(token) {
      const row = this.get(token);
      if (!row || row.revoked) return null;
      if (row.expires_at !== null && row.expires_at <= now()) return null;
      return row;
    },

    close() {
      db.close();
    },
  };
}

// Fixed in-memory token bucket per source: ~30 reads/min on the public
// endpoint. Deliberately not a middleware dependency — one route family
// doesn't justify one — and deliberately lossy about identity: the bucket
// keys on the socket's remote address and nothing else.
export function createRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const buckets = new Map();
  // Lazy sweep: entries are cheap, but an abusive prober would otherwise grow
  // the map without bound.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, b] of buckets) if (b.resetAt <= cutoff) buckets.delete(key);
  }, windowMs).unref();

  return function allow(req) {
    const key = req.socket?.remoteAddress || "unknown";
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count <= max;
  };
}
