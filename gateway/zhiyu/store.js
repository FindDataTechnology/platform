// ── Zhiyu room persistence (add-zhiyu-room) ──────────────────────────────────
//
// The room kernel's own SQLite file at the gateway data root (per-concern
// isolation, same rule as packs.db / wanxing.db). Three tables — rooms,
// members (+invites), messages — hold the whole shared state of a room; the
// 1:1 cell chat stack is untouched by design (D-A). Messages carry a sender
// member reference, which is the core difference from the single-owner
// chat_messages model.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("hex")}`;

export function createZhiyuStore({ file }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");

  // Rooms. reply_cap NULL means "deployment default applies" (the two-level
  // cap config); idle_minutes drives the idle auto-close; source_session
  // records hatch provenance without coupling back to the cell session.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_rooms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    owner_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    reply_cap INTEGER,
    idle_minutes INTEGER NOT NULL DEFAULT 15,
    source_session TEXT,
    daily_budget_turns INTEGER,
    day_stamp TEXT,
    day_turns INTEGER NOT NULL DEFAULT 0,
    proactive_greeting INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  // Pre-existing files lack the column (added 2026-10-27, polish batch 3).
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_rooms') WHERE name = 'proactive_greeting'`).get()) {
    db.exec(`ALTER TABLE zy_rooms ADD COLUMN proactive_greeting INTEGER NOT NULL DEFAULT 0`);
  }

  // Members: the authorization carrier (D-D). kind user|facade|agent; ref is
  // the email (user), deployment ref pack:agent:deployer (facade), or
  // registry slug (agent). A facade member rides for its owner on_behalf_of
  // and its presence flips with the take-over state machine (on_duty ↔
  // listening); a user's presence flips active ↔ away.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_room_members (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    on_behalf_of TEXT,
    display TEXT NOT NULL DEFAULT '',
    alias TEXT NOT NULL DEFAULT '',
    history_grant TEXT NOT NULL DEFAULT 'join_from',
    presence TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT NOT NULL DEFAULT '',
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    state TEXT NOT NULL DEFAULT 'active',
    UNIQUE (room_id, kind, ref)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS zy_room_invites (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    on_behalf_of TEXT,
    display TEXT NOT NULL DEFAULT '',
    history_grant TEXT NOT NULL DEFAULT 'join_from',
    invited_by TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending',
    idem_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`);
  // At most one pending invite per (room, kind, ref) — partial index so a
  // resolved invite never blocks a re-invite.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_zy_invites_pending
    ON zy_room_invites(room_id, kind, ref) WHERE state = 'pending'`);

  // Per-owner answer policies (design D-D): how an invite aimed at the
  // owner's facade(s) resolves when the owner is away — auto_accept | ask
  // (shipped default) | decline. Keyed by owner email; JSON blob keeps room
  // for future policy knobs without migration churn.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_owner_policies (
    email TEXT PRIMARY KEY,
    policies TEXT NOT NULL DEFAULT '{}'
  )`);

  // In-app unread inbox (group 8): invite/call/matter/minutes events user-
  // addressable at the gateway. This is the站内未读 lane; the optional
  // deployment-wide external mirror rides the notify hook opts separately.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_notifications (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    type TEXT NOT NULL,
    room_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    read_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zy_notifications_email ON zy_notifications(email, created_at)`);

  // Widget tokens (add-zhiyu-website-embed D-B): one row per issued embed
  // permit for a room. `wtr_<id>.<sec>` — id is the lookup, only the sec's
  // HASH is kept (no plaintext at rest). identify's site-secret likewise
  // travels as a presented bearer and is stored hashed. allowlist JSON.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_widget_tokens (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sec_hash TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    allowlist TEXT NOT NULL DEFAULT '[]',
    site_secret_hash TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'embed',
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  // One-shot identify nonces (design D-B): presented once, stored hashed.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_widget_nonces (
    nonce TEXT PRIMARY KEY,
    token_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  // Messages: seq is per-room monotonic (allocated max+1 inside the append
  // transaction) so the SSE replay contract (D-E) is trivially honorrable.
  // kind: human | agent | system | event — system/event rows are the stream
  // for caps changes, joins, calls, take-overs; `event` rows (pass marks …)
  // are observability, clients do not render them as bubbles. visibility is
  // 'shared' or 'private:<memberId>' (the private window).
  // Fleet subscriptions (add-zhiyu-team-memory 刀B): a room ↔ fleet event
  // source declaration — NOT a member form (a team is not one speaker). The
  // ownerEmail records WHO subscribed (ownership was verified at subscribe).
  db.exec(`CREATE TABLE IF NOT EXISTS zy_fleet_subs (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    fleet_id TEXT NOT NULL,
    fleet_name TEXT NOT NULL DEFAULT '',
    owner_email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (room_id, fleet_id)
  )`);
  // Event watermark (fix-zhiyu-room-lifecycle-and-bridge-watermark D1): the
  // "already flowed into this room" marker for the bridge, kept on the
  // subscription row so it shares the subscription's lifetime. A process
  // restart, a replaced sample object or an overlapping tick can therefore no
  // longer re-emit an event that already landed. NULL = never baselined.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_fleet_subs') WHERE name = 'watermark'`).get()) {
    db.exec(`ALTER TABLE zy_fleet_subs ADD COLUMN watermark TEXT`);
  }

  db.exec(`CREATE TABLE IF NOT EXISTS zy_room_messages (
    room_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    sender_member_id TEXT,
    from_agent INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'shared',
    content TEXT NOT NULL DEFAULT '',
    meta TEXT,
    provenance TEXT,
    reply_to_seq INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, seq)
  )`);
  // Retention sweep source (fix-…-bridge-watermark): "ended rooms' non-dialogue
  // rows older than N days". The primary key already covers (room_id, seq);
  // this one keeps the age filter off a full scan.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zy_room_messages_kind_created ON zy_room_messages (kind, created_at)`);
  // Small key/value scratch space for "when did the last housekeeping run"
  // markers. It exists so periodic jobs survive pod restarts: production pods
  // here live 20–35 minutes, so any "run N minutes after boot" schedule may
  // never fire (2026-11-10: the retention sweep's 1-hour boot delay would have
  // been reset by every rollout and never run at all).
  db.exec(`CREATE TABLE IF NOT EXISTS zy_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  const now = () => Date.now();

  const q = {
    roomById: db.prepare(`SELECT * FROM zy_rooms WHERE id = ?`),
    memberById: db.prepare(`SELECT * FROM zy_room_members WHERE id = ?`),
    memberByRef: db.prepare(
      `SELECT * FROM zy_room_members WHERE room_id = ? AND kind = ? AND ref = ?`,
    ),
    membersByRoom: db.prepare(
      `SELECT * FROM zy_room_members WHERE room_id = ? ORDER BY joined_at, id`,
    ),
    inviteById: db.prepare(`SELECT * FROM zy_room_invites WHERE id = ?`),
    inviteByIdem: db.prepare(`SELECT * FROM zy_room_invites WHERE idem_key = ?`),
    invitePending: db.prepare(
      `SELECT * FROM zy_room_invites WHERE room_id = ? AND kind = ? AND ref = ? AND state = 'pending'`,
    ),
    maxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM zy_room_messages WHERE room_id = ?`),
  };

  const memberPublic = (m) =>
    m && {
      id: m.id,
      roomId: m.room_id,
      kind: m.kind,
      ref: m.ref,
      onBehalfOf: m.on_behalf_of,
      display: m.display,
      alias: m.alias,
      historyGrant: m.history_grant,
      presence: m.presence,
      invitedBy: m.invited_by,
      joinedAt: m.joined_at,
      state: m.state,
    };

  const roomPublic = (r) =>
    r && {
      id: r.id,
      title: r.title,
      ownerEmail: r.owner_email,
      status: r.status,
      replyCap: r.reply_cap,
      idleMinutes: r.idle_minutes,
      sourceSession: r.source_session,
      dailyBudgetTurns: r.daily_budget_turns,
      dayTurns: r.day_turns,
      proactiveGreeting: Boolean(r.proactive_greeting),
      lastActivityAt: r.last_activity_at,
      createdAt: r.created_at,
      endedAt: r.ended_at,
    };

  const invitePublic = (v) =>
    v && {
      id: v.id,
      roomId: v.room_id,
      kind: v.kind,
      ref: v.ref,
      onBehalfOf: v.on_behalf_of,
      display: v.display,
      historyGrant: v.history_grant,
      invitedBy: v.invited_by,
      state: v.state,
      idemKey: v.idem_key,
      createdAt: v.created_at,
      resolvedAt: v.resolved_at,
    };

  const createInviteTx = db.transaction((inv) => {
    const rowId = id("inv");
    db.prepare(
      `INSERT INTO zy_room_invites
        (id, room_id, kind, ref, on_behalf_of, display, history_grant, invited_by, state, idem_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      rowId,
      inv.roomId,
      inv.kind,
      inv.ref,
      inv.onBehalfOf ?? null,
      inv.display ?? "",
      inv.historyGrant ?? "join_from",
      inv.invitedBy ?? "",
      inv.idemKey,
      now(),
    );
    return q.inviteById.get(rowId);
  });

  return {
    close() {
      db.close();
    },

    // ── Rooms ────────────────────────────────────────────────────────────────
    roomCreate({ title, ownerEmail, idleMinutes = 15, sourceSession = null, replyCap = null }) {
      const roomId = id("zy");
      const ts = now();
      db.prepare(
        `INSERT INTO zy_rooms
          (id, title, owner_email, status, reply_cap, idle_minutes, source_session, last_activity_at, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).run(roomId, title ?? "", ownerEmail, replyCap, idleMinutes, sourceSession, ts, ts);
      return roomPublic(q.roomById.get(roomId));
    },
    roomGet(roomId) {
      return roomPublic(q.roomById.get(roomId));
    },
    roomListFor(email) {
      return db
        .prepare(
          `SELECT r.* FROM zy_rooms r
           WHERE r.owner_email = @email
              OR EXISTS (SELECT 1 FROM zy_room_members m
                          WHERE m.room_id = r.id AND m.kind = 'user' AND m.ref = @email)
              OR EXISTS (SELECT 1 FROM zy_room_members m
                          WHERE m.room_id = r.id AND m.kind = 'facade' AND m.on_behalf_of = @email)
           ORDER BY r.last_activity_at DESC`,
        )
        .all({ email })
        .map(roomPublic);
    },
    roomTouch(roomId, ts = now()) {
      db.prepare(`UPDATE zy_rooms SET last_activity_at = ? WHERE id = ?`).run(ts, roomId);
    },
    roomSetStatus(roomId, status) {
      db.prepare(`UPDATE zy_rooms SET status = ?, ended_at = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END WHERE id = ?`).run(
        status,
        status,
        now(),
        roomId,
      );
      return roomPublic(q.roomById.get(roomId));
    },
    roomPatch(roomId, { title, replyCap, idleMinutes }) {
      if (title !== undefined) db.prepare(`UPDATE zy_rooms SET title = ? WHERE id = ?`).run(title, roomId);
      if (replyCap !== undefined) db.prepare(`UPDATE zy_rooms SET reply_cap = ? WHERE id = ?`).run(replyCap, roomId);
      if (idleMinutes !== undefined) db.prepare(`UPDATE zy_rooms SET idle_minutes = ? WHERE id = ?`).run(idleMinutes, roomId);
      return roomPublic(q.roomById.get(roomId));
    },
    roomSetDailyBudget(roomId, turns) {
      db.prepare(`UPDATE zy_rooms SET daily_budget_turns = ? WHERE id = ?`).run(turns, roomId);
      return roomPublic(q.roomById.get(roomId));
    },
    roomSetProactiveGreeting(roomId, enabled) {
      db.prepare(`UPDATE zy_rooms SET proactive_greeting = ? WHERE id = ?`).run(enabled ? 1 : 0, roomId);
      return roomPublic(q.roomById.get(roomId));
    },
    roomTransferOwner(roomId, email) {
      db.prepare(`UPDATE zy_rooms SET owner_email = ? WHERE id = ?`).run(email, roomId);
      return roomPublic(q.roomById.get(roomId));
    },
    // Idle auto-close sweep source: active rooms whose inactivity exceeds
    // their own per-room idle_minutes.
    // Daily answer budget (spec: 计费与配额挂钩): one atomic read+increment.
    // The day counter resets on UTC-day roll. Returns the NEW day count; the
    // caller compares it against daily_budget_turns, so the first turn that
    // crosses the ceiling is the one refused — never more.
    roomConsumeTurnBudget(roomId) {
      const consumeTx = db.transaction(() => {
        const r = q.roomById.get(roomId);
        if (!r) return null;
        const today = new Date(now()).toISOString().slice(0, 10);
        const count = (r.day_stamp === today ? r.day_turns : 0) + 1;
        db.prepare(`UPDATE zy_rooms SET day_stamp = ?, day_turns = ? WHERE id = ?`).run(today, count, roomId);
        return count;
      });
      return consumeTx();
    },
    // Peek today's answer count without consuming (day-roll aware).
    roomDayTurnsPeek(roomId) {
      const r = q.roomById.get(roomId);
      if (!r) return 0;
      const today = new Date(now()).toISOString().slice(0, 10);
      return r.day_stamp === today ? r.day_turns : 0;
    },
    roomsIdleExpired(nowTs) {
      return db
        .prepare(`SELECT * FROM zy_rooms WHERE status = 'active' AND last_activity_at + idle_minutes * 60000 < ?`)
        .all(nowTs)
        .map(roomPublic);
    },

    // ── Per-owner policies (facade invitation answering) ─────────────────────
    ownerPolicyGet(email) {
      const row = db.prepare(`SELECT * FROM zy_owner_policies WHERE email = ?`).get(email);
      return row ? JSON.parse(row.policies) : {};
    },
    ownerPolicySet(email, patch) {
      const merged = { ...this.ownerPolicyGet(email), ...patch };
      db.prepare(
        `INSERT INTO zy_owner_policies (email, policies) VALUES (?, ?)
         ON CONFLICT(email) DO UPDATE SET policies = excluded.policies`,
      ).run(email, JSON.stringify(merged));
      return merged;
    },

    // ── Members ──────────────────────────────────────────────────────────────
    memberAdd({ roomId, kind, ref, onBehalfOf = null, display = "", alias = "", historyGrant = "join_from", invitedBy = "", presence = null }) {
      const memberId = id("mem");
      const pres = presence ?? (kind === "facade" ? "on_duty" : "active");
      db.prepare(
        `INSERT INTO zy_room_members
          (id, room_id, kind, ref, on_behalf_of, display, alias, history_grant, presence, invited_by, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(memberId, roomId, kind, ref, onBehalfOf, display, alias, historyGrant, pres, invitedBy, now());
      return memberPublic(q.memberById.get(memberId));
    },
    memberFor(roomId, kind, ref) {
      return memberPublic(q.memberByRef.get(roomId, kind, ref));
    },
    memberById(memberId) {
      return memberPublic(q.memberById.get(memberId));
    },
    // INSERT-if-absent: the (room,kind,ref) uniqueness is the idempotency —
    // returns the live row either way.
    memberEnsure(args) {
      const existing = q.memberByRef.get(args.roomId, args.kind, args.ref);
      if (existing) return memberPublic(existing);
      return this.memberAdd(args);
    },
    // Guest → user merge (website-embed identify): keep the SAME row id so
    // message attribution history carries over byte-for-byte; the room's
    // (kind, ref) uniqueness still guards the seat.
    memberUpgradeToUser(memberId, { email, display }) {
      db.prepare(`UPDATE zy_room_members SET kind = 'user', ref = ?, display = ?, presence = 'active' WHERE id = ?`).run(
        email,
        display,
        memberId,
      );
      return memberPublic(q.memberById.get(memberId));
    },
    membersOf(roomId) {
      return q.membersByRoom.all(roomId).map(memberPublic);
    },
    memberSetState(memberId, state) {
      db.prepare(`UPDATE zy_room_members SET state = ?, left_at = CASE WHEN ? = 'active' THEN NULL ELSE ? END WHERE id = ?`).run(
        state,
        state,
        now(),
        memberId,
      );
      return memberPublic(q.memberById.get(memberId));
    },
    memberSetPresence(memberId, presence) {
      db.prepare(`UPDATE zy_room_members SET presence = ? WHERE id = ?`).run(presence, memberId);
      return memberPublic(q.memberById.get(memberId));
    },

    // ── Invites ──────────────────────────────────────────────────────────────
    // Idempotent on idem_key (retried PRs replay the same row) and one pending
    // per (room, kind, ref): a second distinct invite for the same target
    // hands back the existing pending row instead of duplicating.
    inviteCreate(inv) {
      const dup = q.inviteByIdem.get(inv.idemKey);
      if (dup) return { invite: invitePublic(dup), replay: true };
      try {
        return { invite: invitePublic(createInviteTx(inv)), replay: false };
      } catch (err) {
        if (String(err?.code || "").startsWith("SQLITE_CONSTRAINT")) {
          const pending = q.invitePending.get(inv.roomId, inv.kind, inv.ref);
          if (pending) return { invite: invitePublic(pending), replay: true };
        }
        throw err;
      }
    },
    inviteGet(inviteId) {
      return invitePublic(q.inviteById.get(inviteId));
    },
    invitesForRoom(roomId) {
      return db
        .prepare(`SELECT * FROM zy_room_invites WHERE room_id = ? ORDER BY created_at, id`)
        .all(roomId)
        .map(invitePublic);
    },
    // The invites a principal may act on: aimed at them as a user, or at a
    // facade/agent seat they own (on_behalf_of).
    invitesPendingForPrincipal(email) {
      return db
        .prepare(
          `SELECT * FROM zy_room_invites
           WHERE state = 'pending'
             AND ((kind = 'user' AND ref = ?) OR (kind IN ('facade', 'agent') AND on_behalf_of = ?))
           ORDER BY created_at DESC`,
        )
        .all(email, email)
        .map(invitePublic);
    },
    invitesForTarget(kind, ref, onBehalfOf = null) {
      return db
        .prepare(
          `SELECT * FROM zy_room_invites
           WHERE kind = ? AND ref = ? AND COALESCE(on_behalf_of, '') = COALESCE(?, '')
             AND state = 'pending' ORDER BY created_at DESC`,
        )
        .all(kind, ref, onBehalfOf)
        .map(invitePublic);
    },
    inviteResolve(inviteId, state) {
      db.prepare(`UPDATE zy_room_invites SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'`).run(
        state,
        now(),
        inviteId,
      );
      return invitePublic(q.inviteById.get(inviteId));
    },

    // ── Notifications (in-app unread lane) ─────────────────────────────────
    notificationAdd({ email, type, roomId = null, payload = {} }) {
      const nid = id("ntf");
      db.prepare(
        `INSERT INTO zy_notifications (id, email, type, room_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(nid, email, type, roomId, JSON.stringify(payload), now());
      return nid;
    },
    notificationsFor(email, { unreadOnly = false, limit = 100 } = {}) {
      const rows = db
        .prepare(
          `SELECT * FROM zy_notifications WHERE email = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(email, limit);
      return rows.map((r) => ({ id: r.id, type: r.type, roomId: r.room_id, payload: JSON.parse(r.payload), readAt: r.read_at, createdAt: r.created_at }));
    },
    notificationUnreadCount(email) {
      return db.prepare(`SELECT COUNT(*) AS n FROM zy_notifications WHERE email = ? AND read_at IS NULL`).get(email).n;
    },
    notificationMarkRead(email, nid) {
      db.prepare(`UPDATE zy_notifications SET read_at = ? WHERE id = ? AND email = ? AND read_at IS NULL`).run(now(), nid, email);
    },
    // Bulk clear (openspec: polish-web-surfaces, zhiyu-room 通知与触达): viewing
    // the zhiyu page marks the user's whole unread lane read in one statement.
    notificationMarkAllRead(email) {
      db.prepare(`UPDATE zy_notifications SET read_at = ? WHERE email = ? AND read_at IS NULL`).run(now(), email);
    },
    // Clear the notifications a specific room produced for a user of a given
    // type — used when an invite is accepted/declined so its notice clears too.
    notificationMarkReadBy(email, { type, roomId = null }) {
      db.prepare(
        `UPDATE zy_notifications SET read_at = ? WHERE email = ? AND type = ? AND room_id IS ? AND read_at IS NULL`,
      ).run(now(), email, type, roomId);
    },

    // ── Widget tokens (website embed) ────────────────────────────────────────
    widgetTokenCreate({ rowId = null, roomId, secHash, fingerprint, allowlist = [], siteSecretHash, kind = "embed" }) {
      const tid = rowId ?? id("wti");
      db.prepare(
        `INSERT INTO zy_widget_tokens (id, room_id, sec_hash, fingerprint, allowlist, site_secret_hash, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(tid, roomId, secHash, fingerprint, JSON.stringify(allowlist), siteSecretHash, kind, now());
      return this.widgetTokenGet(tid);
    },
    widgetTokenGet(tid) {
      const r = db.prepare(`SELECT * FROM zy_widget_tokens WHERE id = ?`).get(tid);
      return r && {
        id: r.id,
        roomId: r.room_id,
        secHash: r.sec_hash,
        fingerprint: r.fingerprint,
        allowlist: JSON.parse(r.allowlist),
        siteSecretHash: r.site_secret_hash,
        kind: r.kind,
        revokedAt: r.revoked_at,
        createdAt: r.created_at,
      };
    },
    widgetTokensForRoom(roomId) {
      return db
        .prepare(`SELECT * FROM zy_widget_tokens WHERE room_id = ? ORDER BY created_at DESC`)
        .all(roomId)
        .map((r) => ({
          id: r.id,
          roomId: r.room_id,
          secHash: r.sec_hash,
          fingerprint: r.fingerprint,
          allowlist: JSON.parse(r.allowlist),
          siteSecretHash: r.site_secret_hash,
          kind: r.kind,
          createdAt: r.created_at,
          revokedAt: r.revoked_at,
        }));
    },
    widgetTokenSetAllowlist(tid, allowlist) {
      db.prepare(`UPDATE zy_widget_tokens SET allowlist = ? WHERE id = ? AND revoked_at IS NULL`).run(JSON.stringify(allowlist), tid);
      return this.widgetTokenGet(tid);
    },
    widgetTokenRevoke(tid) {
      db.prepare(`UPDATE zy_widget_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), tid);
    },
    widgetTokenRotateSecret(tid, siteSecretHash) {
      db.prepare(`UPDATE zy_widget_tokens SET site_secret_hash = ? WHERE id = ? AND revoked_at IS NULL`).run(siteSecretHash, tid);
      return this.widgetTokenGet(tid);
    },
    widgetNonceBurn(nonce, tokenId) {
      // Single-use: returned true only the first time a nonce is seen.
      try {
        db.prepare(`INSERT INTO zy_widget_nonces (nonce, token_id, created_at) VALUES (?, ?, ?)`).run(nonce, tokenId, now());
        return true;
      } catch {
        return false;
      }
    },
    widgetNoncePurgeOlderThan(thresholdTs) {
      db.prepare(`DELETE FROM zy_widget_nonces WHERE created_at < ?`).run(thresholdTs);
    },

    // ── Fleet subscriptions (add-zhiyu-team-memory 刀B) ─────────────────────
    fleetSubAdd({ roomId, fleetId, fleetName, ownerEmail }) {
      const existing = db.prepare(`SELECT * FROM zy_fleet_subs WHERE room_id = ? AND fleet_id = ?`).get(roomId, fleetId);
      if (existing) return this._fleetSubPublic(existing); // idempotent
      const row = {
        id: `fs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        room_id: roomId,
        fleet_id: fleetId,
        fleet_name: fleetName,
        owner_email: ownerEmail,
        created_at: now(),
      };
      db.prepare(
        `INSERT INTO zy_fleet_subs (id, room_id, fleet_id, fleet_name, owner_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.room_id, row.fleet_id, row.fleet_name, row.owner_email, row.created_at);
      return this._fleetSubPublic(row);
    },
    fleetSubsOf(roomId) {
      return db
        .prepare(`SELECT * FROM zy_fleet_subs WHERE room_id = ? ORDER BY created_at`)
        .all(roomId)
        .map((r) => this._fleetSubPublic(r));
    },
    fleetSubsAll() {
      // Room status rides along (D4): the bridge gates on it, and a subscription
      // view without its room's state is how "events into an ended room"
      // happened in the first place.
      return db
        .prepare(
          `SELECT s.*, r.status AS room_status FROM zy_fleet_subs s
           LEFT JOIN zy_rooms r ON r.id = s.room_id
           ORDER BY s.created_at`,
        )
        .all()
        .map((r) => this._fleetSubPublic(r));
    },
    fleetSubRemove(roomId, subId) {
      const row = db.prepare(`SELECT * FROM zy_fleet_subs WHERE room_id = ? AND id = ?`).get(roomId, subId);
      if (!row) return null;
      db.prepare(`DELETE FROM zy_fleet_subs WHERE room_id = ? AND id = ?`).run(roomId, subId);
      return this._fleetSubPublic(row);
    },
    // Consume one sampling round for one subscription (D2). `consume(current)`
    // receives the persisted watermark (or null on first sight) and returns
    // `{ rows:[{kind,content,meta}], next }` — the rows that are genuinely new
    // (rendered + rate-limited by the caller) and the watermark to persist.
    // Rows and watermark move inside one transaction, and the watermark update
    // is conditional on the value we read, so a racing writer rolls back
    // instead of double-writing the same event.
    fleetSubConsume(roomId, fleetId, consume) {
      const tx = db.transaction(() => {
        const row = db
          .prepare(`SELECT id, watermark FROM zy_fleet_subs WHERE room_id = ? AND fleet_id = ?`)
          .get(roomId, fleetId);
        if (!row) return { ok: false, reason: "no-sub" };
        let current = null;
        if (row.watermark) {
          try {
            current = JSON.parse(row.watermark);
          } catch {
            current = null; // unreadable watermark = never baselined, never fatal
          }
        }
        const decision = consume(current);
        if (!decision) return { ok: true, written: 0, watermark: current };
        const rows = decision.rows ?? [];
        for (const r of rows) {
          const seq = q.maxSeq.get(roomId).m + 1;
          db.prepare(
            `INSERT INTO zy_room_messages
             (room_id, seq, kind, sender_member_id, from_agent, visibility, content, meta, provenance, reply_to_seq, created_at)
             VALUES (?, ?, ?, NULL, 0, 'shared', ?, ?, 'fleet-room-bridge', NULL, ?)`,
          ).run(roomId, seq, r.kind ?? "system", r.content ?? "", r.meta ? JSON.stringify(r.meta) : null, r.createdAt ?? now());
        }
        const next = decision.next ?? current;
        const nextJson = next === null ? null : JSON.stringify(next);
        const changed = db
          .prepare(`UPDATE zy_fleet_subs SET watermark = ? WHERE id = ? AND COALESCE(watermark, '') = ?`)
          .run(nextJson, row.id, row.watermark ?? "").changes;
        if (!changed) {
          const err = new Error("watermark race");
          err.code = "WATERMARK_RACE";
          throw err;
        }
        return { ok: true, written: rows.length, watermark: next };
      });
      try {
        return tx();
      } catch (err) {
        if (err?.code === "WATERMARK_RACE") return { ok: false, reason: "race" };
        throw err;
      }
    },
    _fleetSubPublic(r) {
      return {
        id: r.id,
        roomId: r.room_id,
        fleetId: r.fleet_id,
        fleetName: r.fleet_name,
        ownerEmail: r.owner_email,
        createdAt: r.created_at,
        roomStatus: r.room_status ?? null,
        watermark: r.watermark ?? null,
      };
    },

    // ── Messages ────────────────────────────────────────────────────────────
    // seq allocation is max+1 inside the same write statement's transaction —
    // better-sqlite3 is synchronous single-writer, so two appends can never
    // interleave a seq.
    messageAppend({ roomId, kind, senderMemberId = null, fromAgent = 0, visibility = "shared", content = "", meta = null, provenance = null, replyToSeq = null, createdAt = null }) {
      const appendTx = db.transaction(() => {
        const seq = q.maxSeq.get(roomId).m + 1;
        const ts = createdAt ?? now();
        db.prepare(
          `INSERT INTO zy_room_messages
            (room_id, seq, kind, sender_member_id, from_agent, visibility, content, meta, provenance, reply_to_seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          roomId,
          seq,
          kind,
          senderMemberId,
          fromAgent ? 1 : 0,
          visibility,
          content,
          meta ? JSON.stringify(meta) : null,
          provenance,
          replyToSeq,
          ts,
        );
        return seq;
      });
      const seq = appendTx();
      this.roomTouch(roomId);
      return { seq, row: this.messageAt(roomId, seq) };
    },
    messageAt(roomId, seq) {
      const m = db.prepare(`SELECT * FROM zy_room_messages WHERE room_id = ? AND seq = ?`).get(roomId, seq);
      return m && this._messagePublic(m);
    },
    messagesAfter(roomId, afterSeq = 0, { viewerMemberId = null, limit = 500 } = {}) {
      const rows = db
        .prepare(
          `SELECT * FROM zy_room_messages
           WHERE room_id = ? AND seq > ?
             AND (visibility = 'shared' OR visibility = ?)
           ORDER BY seq LIMIT ?`,
        )
        .all(roomId, afterSeq, viewerMemberId ? `private:${viewerMemberId}` : "\u0000", limit);
      return rows.map((m) => this._messagePublic(m));
    },
    // Backward window (fix-…-bridge-watermark D6): `seq < beforeSeq`, newest
    // last. Visibility filtering is identical to messagesAfter, so paging can
    // neither leak someone else's private row nor hide the caller's own.
    messagesBefore(roomId, beforeSeq, { viewerMemberId = null, limit = 200 } = {}) {
      const rows = db
        .prepare(
          `SELECT * FROM zy_room_messages
           WHERE room_id = ? AND seq < ?
             AND (visibility = 'shared' OR visibility = ?)
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(roomId, beforeSeq, viewerMemberId ? `private:${viewerMemberId}` : "\u0000", limit);
      return rows.reverse().map((m) => this._messagePublic(m));
    },
    // First-screen window: the last `n` visible rows, still ascending.
    messagesTail(roomId, n = 200, opts = {}) {
      return this.messagesBefore(roomId, Number.MAX_SAFE_INTEGER, { ...opts, limit: n });
    },
    // Retention (spec: 空间历史的有界保留). Only ENDED rooms' non-dialogue rows
    // age out — human/agent rows and every private row are product assets that
    // need an explicit delete, never a timeout. dryRun counts without touching.
    pruneRoomSystemRows({ olderThanMs, dryRun = false, batch = 2000 } = {}) {
      const threshold = now() - olderThanMs;
      const where = `room_id IN (SELECT id FROM zy_rooms WHERE status = 'ended')
                       AND kind IN ('system', 'event')
                       AND created_at < ?`;
      const matched = db.prepare(`SELECT COUNT(*) AS n FROM zy_room_messages WHERE ${where}`).get(threshold).n;
      if (dryRun) return { matched, deleted: 0, dryRun: true };
      const del = db.prepare(
        `DELETE FROM zy_room_messages WHERE rowid IN (
           SELECT rowid FROM zy_room_messages WHERE ${where} LIMIT ?
         )`,
      );
      let deleted = 0;
      // Bounded batches: one giant delete would hold the single writer for the
      // whole sweep and stall room traffic behind it.
      for (;;) {
        const n = del.run(threshold, batch).changes;
        deleted += n;
        if (n < batch) break;
      }
      return { matched, deleted, dryRun: false };
    },
    // Housekeeping marker (see zy_meta above). Used by the retention sweep so
    // "last run" survives pod restarts instead of being anchored to boot time.
    metaGet(key) {
      const row = db.prepare(`SELECT value FROM zy_meta WHERE key = ?`).get(key);
      return row ? row.value : null;
    },
    metaSet(key, value) {
      db.prepare(
        `INSERT INTO zy_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, String(value), now());
      return String(value);
    },
    // One retention tick: run only when the last run is older than
    // `minIntervalMs` (or never ran). Persisting the marker — rather than
    // scheduling "N minutes after boot" — is what makes the sweep survive the
    // frequent rollouts; a pod that lives 25 minutes still contributes its tick.
    retentionTick({ olderThanMs, minIntervalMs = 20 * 60 * 60 * 1000, key = "retention_last_run" } = {}) {
      const last = Number(this.metaGet(key) ?? 0) || 0;
      const nowTs = now();
      if (last && nowTs - last < minIntervalMs) {
        return { ran: false, sinceLastMs: nowTs - last };
      }
      const out = this.pruneRoomSystemRows({ olderThanMs });
      this.metaSet(key, String(nowTs));
      return { ran: true, ...out };
    },
    _messagePublic(m) {
      return {
        roomId: m.room_id,
        seq: m.seq,
        kind: m.kind,
        senderMemberId: m.sender_member_id,
        fromAgent: Boolean(m.from_agent),
        visibility: m.visibility,
        content: m.content,
        meta: m.meta ? JSON.parse(m.meta) : null,
        provenance: m.provenance,
        replyToSeq: m.reply_to_seq,
        createdAt: m.created_at,
      };
    },
  };
}
