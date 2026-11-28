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
    billing_mode TEXT NOT NULL DEFAULT 'billed',
    last_activity_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  // Pre-existing files lack the column (added 2026-10-27, polish batch 3).
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_rooms') WHERE name = 'proactive_greeting'`).get()) {
    db.exec(`ALTER TABLE zy_rooms ADD COLUMN proactive_greeting INTEGER NOT NULL DEFAULT 0`);
  }
  // Showcase rooms (declare-zhiyu-keyless-showcase-rooms): rooms that run on
  // free quota on purpose. 'billed' = keys required (default, unchanged);
  // 'showcase' = a keyless seat may answer and its turn is recorded as an
  // EXPECTED unbilled row instead of a configuration gap.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_rooms') WHERE name = 'billing_mode'`).get()) {
    db.exec(`ALTER TABLE zy_rooms ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'billed'`);
  }
  // Session scope (zhiyu-room-session-scope): does one seat keep ONE memory for
  // the whole room, or one per speaker?
  //   NULL / 'shared'  — everyone's words accumulate in one context (the
  //                      pre-change behaviour, byte for byte).
  //   'per-sender'     — each speaker gets its own context; the room's message
  //                      stream stays shared (this is NOT a private chat, it is
  //                      a memory boundary).
  // Why it matters: the room opens per CHAT while seats are keyed per PERSON, so
  // without this a customer's words land in the same memory as the next
  // customer's — measured shape on 2026-11-19: `room:<id>:<seat>` had no
  // speaker dimension at all.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_rooms') WHERE name = 'session_scope'`).get()) {
    db.exec(`ALTER TABLE zy_rooms ADD COLUMN session_scope TEXT`);
  }
  // Context window (zhiyu-room-session-scope D4): how many history rows a turn
  // sees. NULL = inherit the deployment default. It was a hardcoded 40.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_rooms') WHERE name = 'context_window'`).get()) {
    db.exec(`ALTER TABLE zy_rooms ADD COLUMN context_window INTEGER`);
  }
  // Team-account provenance (add-zhiyu-team-account): rooms a team account
  // opened remember which account, so a returning visitor can be sent back to
  // the room they were already in, and an owner can see what their account has
  // spawned. NULL = every room created before accounts existed (unchanged).
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_rooms') WHERE name = 'account_id'`).get()) {
    db.exec(`ALTER TABLE zy_rooms ADD COLUMN account_id TEXT`);
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

  // ── Meeting capture (add-meeting-capture) ─────────────────────────────────
  // A meeting is the CONTAINER for several capture streams, one per attending
  // member. It lives here, not in the platform, because "who is in this room's
  // meeting" is a ROOM fact: eligibility reads zy_room_members, and the meeting's
  // life is bounded by the room's. The platform keeps only a nullable
  // voice_captures.meeting_id, a weak reference (design D1/D3).
  db.exec(`CREATE TABLE IF NOT EXISTS zy_meetings (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    owner_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zy_meetings_room ON zy_meetings(room_id, created_at)`);
  // LiveKit room name for this meeting (add-ai-native-meeting 3.1). A meeting and
  // its media room are ONE object: the name is generated at creation so the
  // worker joins by looking up the meeting, not by an env var pointing at a
  // fixed id. NULL on rows created before this column (a meeting with no media
  // room yet) — the worker treats that as "no room to join".
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_meetings') WHERE name = 'livekit_room'`).get()) {
    db.exec(`ALTER TABLE zy_meetings ADD COLUMN livekit_room TEXT`);
  }
  // Recording state (add-ai-native-meeting 4.2). One JSON array of the objects
  // that were actually written for this meeting:
  //   [{memberRef, key, bytes, startedAt, durationMs}]
  // A column rather than a table because the list is bounded by speakers ×
  // segments and is only ever read whole — by the minutes/read surface and by
  // the authorised download. NULL = not recorded (the capability was off, or the
  // meeting predates it), which the reader must tell apart from "recorded but
  // empty": only the former should offer nothing at all.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_meetings') WHERE name = 'recording'`).get()) {
    db.exec(`ALTER TABLE zy_meetings ADD COLUMN recording TEXT`);
  }

  // One row = one attending member's stream. (meeting, member) is unique: a
  // member has ONE stream per meeting (design D3's explicit non-goal is the
  // same person on two devices). `capture_id` is the platform's id for that
  // stream's audio; `state` is joined | finished | abandoned.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_meeting_participants (
    meeting_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_ref TEXT NOT NULL,
    capture_id TEXT,
    state TEXT NOT NULL DEFAULT 'joined',
    joined_at INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (meeting_id, member_ref)
  )`);

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

  // Team accounts (add-zhiyu-team-account): the address a TEAM answers at, one
  // level above a room. Token verification, allowlists and revocation are
  // untouched — a team account is just ANOTHER TARGET a widget token can point
  // at (`zy_widget_tokens.account_id` below). This table holds the account
  // itself: who owns it, which fleet it stands for, whether it is revoked, and
  // the defaults for the rooms it opens.
  //
  // `fleet_id` is deliberately opaque here: the gateway cannot enumerate a
  // cell's fleets (they live in the owner's cell), so the account stores the
  // id the owner named and every fleet resolution goes through the same
  // `sampleFleets(ownerEmail)` seam the summon plan already uses. "Is this
  // fleet real and mine" is a question asked of the cell, never of a stale
  // copy in the gateway's DB.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_team_accounts (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    fleet_name TEXT NOT NULL DEFAULT '',
    owner_email TEXT NOT NULL,
    idle_minutes INTEGER,
    reply_cap INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS zy_team_accounts_owner ON zy_team_accounts (owner_email)`);

  // Token → target (add-zhiyu-team-account D1): a widget token points at EITHER
  // a room (pre-existing behavior) or a team account. `account_id` NULL is
  // every row that existed before this column — which is why the migration is
  // one nullable ADD: no backfill, no behavior change, and an older gateway
  // reading the table sees exactly the rows it always did.
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_widget_tokens') WHERE name = 'account_id'`).get()) {
    db.exec(`ALTER TABLE zy_widget_tokens ADD COLUMN account_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS zy_widget_tokens_account ON zy_widget_tokens (account_id)`);

  // Mobile→web hand-off links (openspec: add-zhiyu-mobile-clients 5.1/5.2).
  // The mobile clients do not implement private windows, invites or
  // subscription management; they hand the user a link that opens the web
  // surface. That link is a ONE-TIME permit: `used_at` is written by the redeem
  // UPDATE itself, so two concurrent opens cannot both win (`changes === 1` is
  // the whole check). Only the secret's hash is stored and the token carries
  // nothing else — no email, no room id, no session — so a leaked URL reveals
  // nothing and stops working the moment it is used.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_deeplinks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    sec_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zy_deeplinks_room ON zy_deeplinks(room_id, created_at)`);

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

  // 座席音色（add-room-voice-and-catalog）：本场空间对这一席的播报音色指定，
  // `{model, voice}` 的 JSON 文本或 NULL（未指定 → 按岗位/部署回落）。它与
  // display/alias 同级——都是「这个座席在本场怎么被呈现」，属房间自己的事实。
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_room_members') WHERE name = 'voice'`).get()) {
    db.exec(`ALTER TABLE zy_room_members ADD COLUMN voice TEXT`);
  }
  // 邀请也要带音色（add-room-voice-and-catalog）：召唤创建的是 PENDING 邀请，
  // 座席到「接受」那一步才落库；音色若只在邀请对象的内存里，一过重启就丢了。
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('zy_room_invites') WHERE name = 'voice'`).get()) {
    db.exec(`ALTER TABLE zy_room_invites ADD COLUMN voice TEXT`);
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
  // Per-seat read position (openspec: add-caas-delivery-contract).
  //
  // WHY A SECOND TABLE and not a column on zy_room_messages: read state is
  // per (room, member), not per row — one member reading a message must not
  // mark it read for another. A nullable `read_at` column on the message would
  // encode exactly that wrong model, and it would also require touching the
  // primary key the whole transport depends on. A watermark table keeps the
  // message table immutable.
  //
  // This is a SERVER-SIDE fact: it advances when a seat pulls messages over
  // any transport (SSE increment, polling, guest join), never because a page
  // rendered. `/zhiyu/:roomId` has been non-live on web since 11-17 — tying
  // "consumed" to it would make every receipt lie.
  db.exec(`CREATE TABLE IF NOT EXISTS zy_seat_reads (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, member_id)
  )`);
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

  // Room attachments (zhiyu-room-attachments): the bytes belong to the ROOM,
  // never to a member's personal library — a room is a cross-user object and
  // its members' cells are invisible to each other (and absent for guests).
  // `row_seq` is the message row the attachment rides on, and the row's
  // `visibility` is the read authority: there is no second access model here.
  // `location` is relative to the attachment root and is built ONLY from the
  // server-generated id (the original name is a display field, never a path).
  // `status`: ready (text available) | extracting (transcribing) | opaque
  // (this space cannot read that type — NOT a failure) | failed (retryable).
  db.exec(`CREATE TABLE IF NOT EXISTS zy_room_attachments (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    row_seq INTEGER NOT NULL,
    owner_member_id TEXT,
    source_kind TEXT NOT NULL DEFAULT 'member',
    name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',
    extract_chars INTEGER NOT NULL DEFAULT 0,
    extracted_text TEXT,
    error TEXT,
    location TEXT NOT NULL DEFAULT '',
    purged_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zy_attachments_room_row ON zy_room_attachments (room_id, row_seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_zy_attachments_room_created ON zy_room_attachments (room_id, created_at)`);

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
    meetingById: db.prepare(`SELECT * FROM zy_meetings WHERE id = ?`),
    meetingByRoom: db.prepare(`SELECT * FROM zy_meetings WHERE room_id = ? ORDER BY created_at DESC`),
    participantByRef: db.prepare(`SELECT * FROM zy_meeting_participants WHERE meeting_id = ? AND member_ref = ?`),
    participantsByMeeting: db.prepare(`SELECT * FROM zy_meeting_participants WHERE meeting_id = ? ORDER BY joined_at, member_ref`),
    openMeetingsByRoom: db.prepare(`SELECT * FROM zy_meetings WHERE room_id = ? AND status = 'open'`),
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
      // 座席音色（add-room-voice-and-catalog）：本场对该席的指定，null = 未指定。
      voice: m.voice ? JSON.parse(m.voice) : null,
    };

  const meetingPublic = (m) =>
    m && {
      id: m.id,
      roomId: m.room_id,
      title: m.title,
      ownerEmail: m.owner_email,
      status: m.status,
      // The media room this meeting is (null = a pre-media meeting / not yet opened).
      livekitRoom: m.livekit_room ?? null,
      createdAt: m.created_at,
      endedAt: m.ended_at ?? null,
    };

  const participantPublic = (p) =>
    p && {
      meetingId: p.meeting_id,
      memberId: p.member_id,
      memberRef: p.member_ref,
      captureId: p.capture_id ?? null,
      state: p.state,
      joinedAt: p.joined_at,
      finishedAt: p.finished_at ?? null,
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
      billingMode: r.billing_mode === "showcase" ? "showcase" : "billed",
      // add-zhiyu-team-account: which team account opened this room (null for
      // every room created through the pre-existing paths). Provenance, not an
      // authority gate — authorization still runs over membership rows.
      accountId: r.account_id ?? null,
      // zhiyu-room-session-scope: NULL and "shared" are the same thing — the
      // pre-change behaviour. Only the literal "per-sender" switches memory
      // partitioning, so an unrecognised value degrades to shared rather than
      // silently isolating people.
      sessionScope: r.session_scope === "per-sender" ? "per-sender" : "shared",
      contextWindow: r.context_window ?? null,
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
      // 音色（add-room-voice-and-catalog）：召唤时从岗位声明带过来，接受时落到座席。
      voice: v.voice ? JSON.parse(v.voice) : null,
    };

  const createInviteTx = db.transaction((inv) => {
    const rowId = id("inv");
    db.prepare(
      `INSERT INTO zy_room_invites
        (id, room_id, kind, ref, on_behalf_of, display, history_grant, invited_by, state, idem_key, created_at, voice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
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
      inv.voice ? JSON.stringify(inv.voice) : null,
    );
    return q.inviteById.get(rowId);
  });

  return {
    close() {
      db.close();
    },

    // ── Rooms ────────────────────────────────────────────────────────────────
    roomCreate({ title, ownerEmail, idleMinutes = 15, sourceSession = null, replyCap = null, accountId = null }) {
      const roomId = id("zy");
      const ts = now();
      db.prepare(
        `INSERT INTO zy_rooms
          (id, title, owner_email, status, reply_cap, idle_minutes, source_session, account_id, last_activity_at, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      ).run(roomId, title ?? "", ownerEmail, replyCap, idleMinutes, sourceSession, accountId, ts, ts);
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
    roomPatch(roomId, { title, replyCap, idleMinutes, billingMode, sessionScope, contextWindow }) {
      if (title !== undefined) db.prepare(`UPDATE zy_rooms SET title = ? WHERE id = ?`).run(title, roomId);
      if (replyCap !== undefined) db.prepare(`UPDATE zy_rooms SET reply_cap = ? WHERE id = ?`).run(replyCap, roomId);
      if (idleMinutes !== undefined) db.prepare(`UPDATE zy_rooms SET idle_minutes = ? WHERE id = ?`).run(idleMinutes, roomId);
      if (billingMode !== undefined) {
        db.prepare(`UPDATE zy_rooms SET billing_mode = ? WHERE id = ?`).run(billingMode === "showcase" ? "showcase" : "billed", roomId);
      }
      // Session scope (zhiyu-room-session-scope): stored as NULL when shared so
      // "never touched" and "explicitly shared" are the same row shape — the
      // reader treats both identically, and a rollback leaves no trace.
      if (sessionScope !== undefined) {
        db.prepare(`UPDATE zy_rooms SET session_scope = ? WHERE id = ?`).run(
          sessionScope === "per-sender" ? "per-sender" : null,
          roomId,
        );
      }
      if (contextWindow !== undefined) {
        db.prepare(`UPDATE zy_rooms SET context_window = ? WHERE id = ?`).run(contextWindow, roomId);
      }
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
    // Idle auto-close sweep source: active rooms whose inactivity exceeds their
    // own per-room idle_minutes.
    //
    // `idle_minutes = 0` means NEVER (fix-zhiyu-permanent-rooms D1). The
    // arithmetic below can never satisfy `last_activity + 0 < now` for a real
    // timestamp, but the guard is spelled out anyway: "0 means never" is a
    // documented contract, and a reader must not have to derive it from
    // timestamp arithmetic that happens to work.
    // ── Attachments (zhiyu-room-attachments) ───────────────────────────────
    attachmentAdd({ id: aid, roomId, rowSeq, ownerMemberId = null, sourceKind = "member", name = "", mime = "", bytes = 0, status = "ready", location = "", extractedText = null, extractChars = 0 }) {
      db.prepare(
        `INSERT INTO zy_room_attachments
          (id, room_id, row_seq, owner_member_id, source_kind, name, mime, bytes, status, extract_chars, extracted_text, location, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(aid, roomId, rowSeq, ownerMemberId, sourceKind, name, mime, bytes, status, extractChars, extractedText, location, now());
      return this.attachmentGet(aid);
    },
    attachmentGet(aid) {
      const r = db.prepare(`SELECT * FROM zy_room_attachments WHERE id = ?`).get(aid);
      return r ? this._attachmentPublic(r) : null;
    },
    attachmentOfRow(roomId, rowSeq) {
      const r = db.prepare(`SELECT * FROM zy_room_attachments WHERE room_id = ? AND row_seq = ?`).get(roomId, rowSeq);
      return r ? this._attachmentPublic(r) : null;
    },
    // The ONLY mutation the processing lane needs. Setting a terminal state
    // carries the text with it, so "text present" and "status ready" can never
    // disagree (the same one-statement discipline as the capture lane's D6).
    attachmentSetResult(aid, { status, extractedText = null, error = null }) {
      db.prepare(`UPDATE zy_room_attachments SET status = ?, extracted_text = ?, extract_chars = ?, error = ? WHERE id = ?`).run(
        status,
        extractedText,
        extractedText ? extractedText.length : 0,
        error,
        aid,
      );
      return this.attachmentGet(aid);
    },
    // Sum of a room's live bytes — the per-room quota reads this, so a purged
    // attachment stops counting (its row stays, its bytes do not).
    attachmentRoomBytes(roomId) {
      return db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM zy_room_attachments WHERE room_id = ? AND purged_at IS NULL`).get(roomId).n;
    },
    attachmentOwnerBytesToday(roomId, ownerMemberId, sinceTs) {
      return db
        .prepare(
          `SELECT COALESCE(SUM(bytes), 0) AS n FROM zy_room_attachments
           WHERE room_id = ? AND owner_member_id = ? AND created_at >= ? AND purged_at IS NULL`,
        )
        .get(roomId, ownerMemberId, sinceTs).n;
    },
    // Retention acts on BYTES, never on rows (spec: 空间历史的有界保留 — a
    // room has no delete-a-message action, so "row gone ⇒ bytes gone" is not
    // an implementable landing point). Purged rows keep their metadata so the
    // card can say 已过期 instead of silently vanishing.
    attachmentsToPurge({ olderThanMs, limit = 200 }) {
      return db
        .prepare(
          `SELECT * FROM zy_room_attachments
           WHERE purged_at IS NULL AND location <> ''
             AND room_id IN (SELECT id FROM zy_rooms WHERE status = 'ended')
             AND created_at < ?
           ORDER BY created_at LIMIT ?`,
        )
        .all(now() - olderThanMs, limit)
        .map((r) => this._attachmentPublic(r));
    },
    attachmentMarkPurged(aid) {
      db.prepare(`UPDATE zy_room_attachments SET purged_at = ?, extracted_text = NULL WHERE id = ?`).run(now(), aid);
    },
    // Orphans: a location whose row is gone entirely (hand-deleted DB, a crash
    // between write and insert). Reported, never guessed at.
    attachmentsAllLocations() {
      return db
        .prepare(`SELECT id, location, purged_at FROM zy_room_attachments WHERE location <> ''`)
        .all()
        .map((r) => ({ id: r.id, location: r.location, purged: Boolean(r.purged_at) }));
    },
    _attachmentPublic(r) {
      return {
        id: r.id,
        roomId: r.room_id,
        rowSeq: r.row_seq,
        ownerMemberId: r.owner_member_id,
        sourceKind: r.source_kind,
        name: r.name,
        mime: r.mime,
        bytes: r.bytes,
        status: r.status,
        extractChars: r.extract_chars,
        // The card model needs "is there text to hand the agent", never the
        // text itself on list reads; the prompt assembler asks for it by id.
        hasText: Boolean(r.extracted_text),
        error: r.error,
        purged: Boolean(r.purged_at),
        createdAt: r.created_at,
      };
    },
    attachmentText(aid) {
      const r = db.prepare(`SELECT extracted_text FROM zy_room_attachments WHERE id = ?`).get(aid);
      return r?.extracted_text ?? null;
    },
    // Disk location, kept OUT of the public projection on purpose: a response
    // body has no business naming a path on the node. Only the byte reader
    // asks for it, and only for an id it already resolved.
    attachmentLocation(aid) {
      const r = db.prepare(`SELECT location, purged_at FROM zy_room_attachments WHERE id = ?`).get(aid);
      return r && !r.purged_at ? r.location : null;
    },
    roomsIdleExpired(nowTs) {
      return db
        .prepare(
          `SELECT * FROM zy_rooms
            WHERE status = 'active' AND idle_minutes > 0
              AND last_activity_at + idle_minutes * 60000 < ?`,
        )
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
    memberAdd({ roomId, kind, ref, onBehalfOf = null, display = "", alias = "", historyGrant = "join_from", invitedBy = "", presence = null, voice = null }) {
      const memberId = id("mem");
      const pres = presence ?? (kind === "facade" ? "on_duty" : "active");
      db.prepare(
        `INSERT INTO zy_room_members
          (id, room_id, kind, ref, on_behalf_of, display, alias, history_grant, presence, invited_by, joined_at, voice)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(memberId, roomId, kind, ref, onBehalfOf, display, alias, historyGrant, pres, invitedBy, now(), voice ? JSON.stringify(voice) : null);
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
    // ── Meeting capture (add-meeting-capture) ────────────────────────────────
    /** Open a meeting in a room. One room may hold many, in sequence. */
    meetingCreate({ roomId, title = "", ownerEmail }) {
      const meetingId = id("zym");
      // The media room name is derived from the meeting id: stable, unique, and
      // not guessable-before-creation. A meeting and its LiveKit room are one
      // object — the worker resolves the room by looking the meeting up.
      const livekitRoom = `mtg-${meetingId}`;
      db.prepare(
        `INSERT INTO zy_meetings (id, room_id, title, owner_email, status, created_at, livekit_room)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      ).run(meetingId, roomId, title, ownerEmail, now(), livekitRoom);
      return meetingPublic(q.meetingById.get(meetingId));
    },
    meetingGet(meetingId) {
      return meetingPublic(q.meetingById.get(meetingId));
    },
    meetingsOf(roomId) {
      return q.meetingByRoom.all(roomId).map(meetingPublic);
    },
    /**
     * Join = claim YOUR stream. Idempotent per (meeting, member): the second
     * join returns the same row, so a double tap cannot create a second stream
     * (design D3 — "one person, one stream" is the model, not a UI detail).
     *
     * The member is resolved by the CALLER from the room's own membership; this
     * function must never accept a ref the room does not know, or "joined"
     * would become a client-side claim.
     */
    meetingJoin({ meetingId, member }) {
      const existing = q.participantByRef.get(meetingId, member.ref);
      if (existing) return { participant: participantPublic(existing), created: false };
      db.prepare(
        `INSERT INTO zy_meeting_participants (meeting_id, member_id, member_ref, capture_id, state, joined_at)
         VALUES (?, ?, ?, NULL, 'joined', ?)`,
      ).run(meetingId, member.id, member.ref, now());
      return { participant: participantPublic(q.participantByRef.get(meetingId, member.ref)), created: true };
    },
    /** Attach the platform capture that carries this stream's audio. */
    meetingSetCapture({ meetingId, memberRef, captureId }) {
      db.prepare(`UPDATE zy_meeting_participants SET capture_id = ? WHERE meeting_id = ? AND member_ref = ?`).run(
        captureId,
        meetingId,
        memberRef,
      );
      return participantPublic(q.participantByRef.get(meetingId, memberRef));
    },
    /** joined → finished | abandoned. Terminal states are not undone. */
    meetingSetStreamState({ meetingId, memberRef, state }) {
      db.prepare(
        `UPDATE zy_meeting_participants
            SET state = ?, finished_at = CASE WHEN ? IN ('finished','abandoned') THEN ? ELSE finished_at END
          WHERE meeting_id = ? AND member_ref = ?`,
      ).run(state, state, now(), meetingId, memberRef);
      return participantPublic(q.participantByRef.get(meetingId, memberRef));
    },
    meetingParticipants(meetingId) {
      return q.participantsByMeeting.all(meetingId).map(participantPublic);
    },
    /** End = stop accepting joins. It does NOT cascade into captures (D6). */
    meetingEnd(meetingId) {
      db.prepare(`UPDATE zy_meetings SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'open'`).run(
        now(),
        meetingId,
      );
      return meetingPublic(q.meetingById.get(meetingId));
    },
    /**
     * Record one written segment (add-ai-native-meeting 4.2).
     *
     * APPEND-ONLY and idempotent per key: the worker retries an upload when the
     * platform's answer is lost, and a retry must not double-count a file. The
     * object key is the identity, because it names the segment.
     *
     * Returns the full list after the append so the caller can answer with what
     * the platform now believes was recorded — not with what it hoped.
     */
    meetingRecordingAppend(meetingId, entry = {}) {
      const row = q.meetingById.get(meetingId);
      if (!row) return null;
      let list = [];
      try { list = row.recording ? JSON.parse(row.recording) : []; } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      const key = String(entry.key ?? "");
      if (!key) return list;
      const at = list.findIndex((x) => x && x.key === key);
      const next = {
        memberRef: String(entry.memberRef ?? "").toLowerCase() || null,
        key,
        bytes: Number(entry.bytes) || 0,
        durationMs: Number(entry.durationMs) || 0,
        at: now(),
      };
      if (at >= 0) list[at] = { ...list[at], ...next };
      else list.push(next);
      db.prepare(`UPDATE zy_meetings SET recording = ? WHERE id = ?`).run(JSON.stringify(list), meetingId);
      return list;
    },
    /** The segments recorded for this meeting. null = the meeting never recorded. */
    meetingRecording(meetingId) {
      const row = q.meetingById.get(meetingId);
      if (!row) return null;
      if (!row.recording) return null;
      try {
        const list = JSON.parse(row.recording);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },
    /** Is there an open meeting in this room that already has this person? */
    meetingOpenForMember({ roomId, memberRef }) {
      const open = q.openMeetingsByRoom.all(roomId);
      for (const m of open) {
        const p = q.participantByRef.get(m.id, memberRef);
        if (p) return { meeting: meetingPublic(m), participant: participantPublic(p) };
      }
      return null;
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
    // 座席音色（add-room-voice-and-catalog）：null 清除 = 回落到岗位/部署默认。
    memberSetVoice(memberId, voice) {
      db.prepare(`UPDATE zy_room_members SET voice = ? WHERE id = ?`).run(voice ? JSON.stringify(voice) : null, memberId);
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
      const publicRow = (r) => ({
        id: r.id,
        type: r.type,
        roomId: r.room_id,
        payload: JSON.parse(r.payload),
        readAt: r.read_at,
        createdAt: r.created_at,
      });
      const base = db
        .prepare(
          `SELECT * FROM zy_notifications WHERE email = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(email, limit);
      if (unreadOnly) return base.map(publicRow);
      // …plus every unread row the newest-`limit` window missed
      // (add-zhiyu-mobile-clients 6.2). Without this, a badge can point at
      // nothing: 100 read rows newer than one old unread row put the unread row
      // outside the page, so the panel shows a count with no entry to clear it.
      const seen = new Set(base.map((r) => r.id));
      const extra = db
        .prepare(`SELECT * FROM zy_notifications WHERE email = ? AND read_at IS NULL ORDER BY created_at DESC, id DESC`)
        .all(email)
        .filter((r) => !seen.has(r.id));
      return [...base, ...extra]
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
        .map(publicRow);
    },
    notificationUnreadCount(email) {
      return db.prepare(`SELECT COUNT(*) AS n FROM zy_notifications WHERE email = ? AND read_at IS NULL`).get(email).n;
    },
    // Returns the row it just cleared (or null when it was already read / not
    // this user's), so the caller can act on WHAT was read — the broadcast sync
    // needs the payload's broadcastId and must not re-read the row afterwards
    // (a concurrent read would already have cleared it).
    notificationMarkRead(email, nid) {
      const row = db
        .prepare(`SELECT * FROM zy_notifications WHERE id = ? AND email = ? AND read_at IS NULL`)
        .get(nid, email);
      if (!row) return null;
      db.prepare(`UPDATE zy_notifications SET read_at = ? WHERE id = ? AND email = ? AND read_at IS NULL`).run(
        now(),
        nid,
        email,
      );
      return { id: row.id, type: row.type, roomId: row.room_id, payload: JSON.parse(row.payload) };
    },
    // Bulk clear (openspec: polish-web-surfaces, zhiyu-room 通知与触达): viewing
    // the zhiyu page marks the user's whole unread lane read in one statement.
    // Clear the unread lane, optionally RESTRICTED to a set of types.
    //
    // Why the restriction exists (broadcast-reaches-zhiyu): the zhiyu page
    // clears this lane on mount so the nav badge reaches zero deterministically.
    // That is right for "you were invited / the minutes are ready" — browsing
    // the page IS reading them. It is wrong for a broadcast, which the user has
    // not seen yet: clearing it on arrival means the message is gone before it
    // can be read. Callers that pass no types keep the historical
    // clear-everything behaviour, so the three existing producers are untouched.
    notificationMarkAllRead(email, { types = null } = {}) {
      if (Array.isArray(types) && types.length) {
        const holes = types.map(() => "?").join(", ");
        db.prepare(
          `UPDATE zy_notifications SET read_at = ? WHERE email = ? AND read_at IS NULL AND type IN (${holes})`,
        ).run(now(), email, ...types);
        return;
      }
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
    widgetTokenCreate({ rowId = null, roomId = "", accountId = null, secHash, fingerprint, allowlist = [], siteSecretHash, kind = "embed" }) {
      const tid = rowId ?? id("wti");
      db.prepare(
        `INSERT INTO zy_widget_tokens (id, room_id, account_id, sec_hash, fingerprint, allowlist, site_secret_hash, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(tid, roomId, accountId, secHash, fingerprint, JSON.stringify(allowlist), siteSecretHash, kind, now());
      return this.widgetTokenGet(tid);
    },
    widgetTokenGet(tid) {
      const r = db.prepare(`SELECT * FROM zy_widget_tokens WHERE id = ?`).get(tid);
      return r && {
        id: r.id,
        roomId: r.room_id,
        accountId: r.account_id ?? null,
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
          accountId: r.account_id ?? null,
          secHash: r.sec_hash,
          fingerprint: r.fingerprint,
          allowlist: JSON.parse(r.allowlist),
          siteSecretHash: r.site_secret_hash,
          kind: r.kind,
          createdAt: r.created_at,
          revokedAt: r.revoked_at,
        }));
    },
    widgetTokensForAccount(accountId) {
      return db
        .prepare(`SELECT * FROM zy_widget_tokens WHERE account_id = ? ORDER BY created_at DESC`)
        .all(accountId)
        .map((r) => ({
          id: r.id,
          roomId: r.room_id,
          accountId: r.account_id,
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

    // ── Team accounts (add-zhiyu-team-account) ───────────────────────────────
    teamAccountCreate({ id: aid = null, fleetId, fleetName = "", ownerEmail, idleMinutes = null, replyCap = null }) {
      const accId = aid ?? id("fd");
      db.prepare(
        `INSERT INTO zy_team_accounts (id, fleet_id, fleet_name, owner_email, idle_minutes, reply_cap, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(accId, fleetId, fleetName, ownerEmail, idleMinutes, replyCap, now());
      return this.teamAccountGet(accId);
    },
    teamAccountGet(aid) {
      const r = db.prepare(`SELECT * FROM zy_team_accounts WHERE id = ?`).get(aid);
      return r && this._teamAccountPublic(r);
    },
    teamAccountsForOwner(email) {
      return db
        .prepare(`SELECT * FROM zy_team_accounts WHERE owner_email = ? ORDER BY created_at DESC`)
        .all(email)
        .map((r) => this._teamAccountPublic(r));
    },
    // Idempotent: revoking an already-revoked account is a no-op, not an error
    // (a management face may double-fire on a slow double-click).
    teamAccountRevoke(aid) {
      db.prepare(`UPDATE zy_team_accounts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), aid);
      return this.teamAccountGet(aid);
    },
    teamAccountPatch(aid, { idleMinutes, replyCap, fleetName }) {
      if (idleMinutes !== undefined) db.prepare(`UPDATE zy_team_accounts SET idle_minutes = ? WHERE id = ?`).run(idleMinutes, aid);
      if (replyCap !== undefined) db.prepare(`UPDATE zy_team_accounts SET reply_cap = ? WHERE id = ?`).run(replyCap, aid);
      if (fleetName !== undefined) db.prepare(`UPDATE zy_team_accounts SET fleet_name = ? WHERE id = ?`).run(fleetName, aid);
      return this.teamAccountGet(aid);
    },
    // Which room did this account most recently open for this visitor? The
    // guest pass carries (accountId, ref); on a return visit we look for the
    // member row that pass already created inside an account-opened room, so a
    // conversation is not restarted in a fresh room on every page load.
    accountRoomForVisitor(accountId, ref) {
      const r = db
        .prepare(
          `SELECT room_id FROM zy_room_members
            WHERE kind = 'guest' AND ref = ? AND room_id IN (SELECT id FROM zy_rooms WHERE account_id = ?)
            ORDER BY joined_at DESC LIMIT 1`,
        )
        .get(ref, accountId);
      return r?.room_id ?? null;
    },
    // Every room this account opened (newest first). The IM lane uses it to
    // find the room a given group already lives in — one chat is one room, and
    // the derived title is the key (no join table needed).
    roomsOfAccount(accountId) {
      return db
        .prepare(`SELECT * FROM zy_rooms WHERE account_id = ? ORDER BY last_activity_at DESC`)
        .all(accountId)
        .map(roomPublic);
    },
    _teamAccountPublic(r) {
      return {
        id: r.id,
        fleetId: r.fleet_id,
        fleetName: r.fleet_name,
        ownerEmail: r.owner_email,
        idleMinutes: r.idle_minutes,
        replyCap: r.reply_cap,
        createdAt: r.created_at,
        revokedAt: r.revoked_at ?? null,
      };
    },

    // ── Mobile→web hand-off links (add-zhiyu-mobile-clients 5.1/5.2) ────────
    deepLinkCreate({ id: did, roomId, purpose, secHash, createdBy, expiresAt }) {
      db.prepare(
        `INSERT INTO zy_deeplinks (id, room_id, purpose, sec_hash, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(did, roomId, purpose, secHash, createdBy, now(), expiresAt);
      return this.deepLinkGet(did);
    },
    deepLinkGet(did) {
      const r = db.prepare(`SELECT * FROM zy_deeplinks WHERE id = ?`).get(did);
      return (
        r && {
          id: r.id,
          roomId: r.room_id,
          purpose: r.purpose,
          secHash: r.sec_hash,
          createdBy: r.created_by,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          usedAt: r.used_at,
          usedBy: r.used_by,
        }
      );
    },
    /**
     * Burn the link and return its row — or null if it was already used or has
     * expired.
     *
     * The single-use property is the UPDATE's own WHERE clause, not a read
     * followed by a write: two opens racing on the same link produce exactly
     * one `changes === 1` and one winner (5.2). A read-then-write would let both
     * see `used_at IS NULL` and both proceed.
     */
    deepLinkRedeem(did, { usedBy = null } = {}) {
      const row = this.deepLinkGet(did);
      if (!row) return null;
      const res = db
        .prepare(`UPDATE zy_deeplinks SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?`)
        .run(now(), usedBy, did, now());
      return res.changes === 1 ? row : null;
    },
    deepLinksForRoom(roomId) {
      return db
        .prepare(`SELECT * FROM zy_deeplinks WHERE room_id = ? ORDER BY created_at DESC`)
        .all(roomId)
        .map((r) => ({
          id: r.id,
          roomId: r.room_id,
          purpose: r.purpose,
          createdBy: r.created_by,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          usedAt: r.used_at,
          usedBy: r.used_by,
        }));
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
    // Merge a patch into the row's `meta` (zhiyu-room-attachments: the
    // attachment reference lands on the row it rides, so every reader finds it
    // the same way — no second lookup table to keep in step).
    messagePatchMeta(roomId, seq, patch) {
      const m = db.prepare(`SELECT meta FROM zy_room_messages WHERE room_id = ? AND seq = ?`).get(roomId, seq);
      if (!m) return null;
      let base = {};
      try {
        base = m.meta ? JSON.parse(m.meta) : {};
      } catch {
        base = {};
      }
      db.prepare(`UPDATE zy_room_messages SET meta = ? WHERE room_id = ? AND seq = ?`).run(
        JSON.stringify({ ...base, ...patch }),
        roomId,
        seq,
      );
      return this.messageAt(roomId, seq);
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
    // ── Per-seat read position (add-caas-delivery-contract) ──────────────────
    //
    // `last_seq` only ever moves forward (monotonic): a client that replays an
    // older window must not rewind the position, or a delivery marked consumed
    // would flip back. The UPDATE ... WHERE last_seq < ? does that in one
    // statement, so concurrent pulls cannot regress it either.
    seatReadAdvance(roomId, memberId, seq) {
      if (!roomId || !memberId || !Number.isFinite(Number(seq))) return 0;
      const n = Number(seq);
      db.prepare(
        `INSERT INTO zy_seat_reads (room_id, member_id, last_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, member_id) DO UPDATE
           SET last_seq = MAX(last_seq, excluded.last_seq),
               updated_at = excluded.updated_at`,
      ).run(roomId, memberId, n, now());
      return db.prepare(`SELECT last_seq FROM zy_seat_reads WHERE room_id = ? AND member_id = ?`).get(roomId, memberId)?.last_seq ?? 0;
    },
    seatReadPosition(roomId, memberId) {
      return db.prepare(`SELECT last_seq FROM zy_seat_reads WHERE room_id = ? AND member_id = ?`).get(roomId, memberId)?.last_seq ?? 0;
    },
    // Which delivery rows (bridge report lines) a seat has already consumed?
    // Reads the seq of every system row carrying a delivery receipt and compares
    // it to the seat's position. Used by the receipt reconciler, not by the
    // transport — the transport only advances the position.
    seatConsumedDeliveries(roomId, memberId) {
      const pos = db.prepare(`SELECT last_seq FROM zy_seat_reads WHERE room_id = ? AND member_id = ?`).get(roomId, memberId)?.last_seq ?? -1;
      const rows = db
        .prepare(
          `SELECT seq, meta FROM zy_room_messages
           WHERE room_id = ? AND json_extract(meta, '$.delivery') IS NOT NULL`,
        )
        .all(roomId);
      const out = [];
      for (const r of rows) {
        let meta = null;
        try {
          meta = r.meta ? JSON.parse(r.meta) : null;
        } catch {
          meta = null;
        }
        if (!meta?.delivery) continue;
        out.push({ seq: r.seq, idem: meta.delivery.idem, consumed: r.seq <= pos, delivery: meta.delivery });
      }
      return out;
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
