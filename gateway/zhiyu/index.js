// ── Zhiyu room kernel wiring (add-zhiyu-room) ────────────────────────────────
//
// 萬星·智语 phase 1: multi-human × multi-agent rooms, mounted on the gateway
// process because a room is a cross-user object and cells are per-user
// processes (design D-A). The module owns the whole /api/zhiyu prefix: every
// room route goes through resolveUser membership auth, and anything the
// prefix does not name answers 404 here instead of falling through to the
// cell proxy — room objects must not leak into (or out of) the 1:1 cell stack.
//
// Access model (design D-D): a room is visible to its owner, to active user
// members, and to the principal of an active facade member (the owner a
// facade rides for — they follow their own 值守分身). Everyone else gets the
// 404 same-as-nonexistent shape.

import path from "node:path";
import { readFileSync } from "node:fs";
import express from "express";
import { EventEmitter } from "node:events";
import multer from "multer";
import { createZhiyuStore } from "./store.js";
import { createRoomRouter } from "./room-router.js";
import { createCommander } from "./commander.js";
import { createAttachmentStore, buildAttachmentBlock, isAudio, canExtract } from "./attachments.js";
import { createVoiceForwarder } from "./voice-forward.js";
import { chatMemoryBlockFor } from "@finddatatechnology/yongyi-client";
import { newWidgetToken, newSiteSecret, verifyWidgetToken, hostAllowed, signGuestPass, verifyGuestPass, verifyIdentify, guestRefFor } from "./guest-auth.js";
import { mintDeeplink, redeemDeeplink, verifyDeeplink, isDeeplinkPurpose, DEEPLINK_PURPOSES } from "./deeplink.js";
import { registerZhiyuImBridge } from "./im-bridge.js";
import { registerZhiyuCaptureIngest } from "./capture-ingest.js";
import { createRoomSpeech, registerZhiyuRoomSpeech } from "./room-speech.js";

export function registerZhiyuRoutes(app, {
  dataRoot,
  resolveUser,
  rejectUnauthenticated,
  env = process.env,
  secret = "", // HMAC anchor for guest passes (the gateway's CELL_GATEWAY_SECRET)
  webDist = null, // web/dist dir for the embed shell (dynamic CSP route)
  // Injection seams for tests.
  store: storeOpt = null,
  cellExport = null, // (user, sessionId, window) → cell hatch export payload
  callAgent = null, // (member, { text, contextId, onDelta }) → { text } — the live agent lane
  settleTurn = null, // (member, { usageId, minutes }) → void — per-deployment billing (group 7)
  onHumanMessage = null, // round-router override hook (whole-sale test seam)
  memoryBlock = null, // room-turn memory seam override (see the wired default below)
  voiceRoute = null, // voice-routing seam (add-voice-routing 3.1): null = legacy broadcast
  notify = null, // notification lanes hook (task group 8)
  onRoomEnded = null, // minutes generation hook (task group 8)
  // Fleet sample seam (add-zhiyu-team-account): (ownerEmail) => { fleets } | null
  // — the same cell-sourced overview the summon plan uses. Absent (tests,
  // degraded wiring) → account creation answers 404 instead of trusting the
  // request body's fleet id.
  sampleFleets = null,
  // Seats a team account's serving members into the room it opens. One module
  // for the widget lane and the IM bridge — two copies would drift silently.
  accountRoomSeeder = null,
  ssePollMs = 1000,
  sweepMs = 30_000,
  startTimers = true,
  proactiveDelayMs = 20_000, // deliberate pause before a duty seat greets an unanswered visitor (opt-in per room)
  // The /api/zhiyu/* prefix 404 guard must be the LAST zhiyu registration on
  // the app. Production registers fleet-room-bridge AFTER this function
  // returns, so it defers the guard and calls zhiyu.registerNotFound() once
  // every zhiyu route (kernel + IM bridge + fleet bridge) is mounted. Tests
  // that mount this module alone keep the inline guard (default false).
  deferNotFound = false,
}) {
  const store = storeOpt ?? createZhiyuStore({ file: path.join(dataRoot, "zhiyu.db") });

  // Room attachments (zhiyu-room-attachments): bytes belong to the room, on the
  // same data root as zhiyu.db. The transcription lane is gateway-side and
  // deployment-keyed (voice-forward.js) because a room has no member cell.
  const attachmentRoot = path.join(dataRoot, "zhiyu-attachments");
  const voiceForward = createVoiceForwarder({ env });
  const attachments = createAttachmentStore({
    store,
    root: attachmentRoot,
    env,
    // Settled-audio trace row: readable, no turn, no quota (spec requirement).
    onSettled: (att) => {
      try {
        store.messageAppend({
          roomId: att.roomId,
          kind: "event",
          content: "",
          meta: { event: "attachment_ready", attachmentId: att.id, name: att.name, chars: att.extractChars },
        });
      } catch (err) {
        console.warn(`[zhiyu-attach] ready trace failed: ${err?.message || err}`);
      }
    },
    transcribe: (args) => voiceForward.transcribe(args),
  });

  // Two-level reply-cap config (spec: 回合协议与熔断): deployment default from
  // env (shipped 3) with a deployment-wide bounds range (shipped 1–20).
  const replyCap = {
    default: clampInt(env.ZHIYU_REPLY_CAP_DEFAULT, 3, 1, 100),
    min: clampInt(env.ZHIYU_REPLY_CAP_MIN, 1, 1, 100),
    max: clampInt(env.ZHIYU_REPLY_CAP_MAX, 20, 1, 100),
  };
  const effectiveCap = (room) => room?.replyCap ?? replyCap.default;

  // The round router + ephemeral overlay bus (design D-B/D-E). Without a
  // wired agent lane, callAgent refuses loudly and turns settle as honest
  // `agent_failed` events — an unconfigured deployment still has fully
  // functional human-only rooms rather than a silent void.
  const bus = new EventEmitter();
  const missingLane = async () => {
    throw new Error("agent lane not configured on this deployment");
  };
  // Room-turn memory (unified-memory-and-outputs D7): the asking party's own
  // memory rides the chat lane's seam and switch — a signed-in member answers
  // as their owner (kind=user, ref=email), a guest never injects. Env-off or
  // any failure returns "" and the turn proceeds byte-identically.
  // 记忆块是锦上添花，不是回合的前置条件。prod 实测 fd-memory /digest 5–14s
  // （embed 面慢，见 fd-memory 日志 `[digest] … ms=5xxx..14117`），串在 agent
  // 调用前等于每条房间回复白等一个数量级。超时即当没有——沿用阶梯自己的
  // degrade-open 哲学，不新增降级档位。ZHIYU_MEMORY_DEADLINE_MS 可调，0 关闭等待。
  const memoryDeadlineMs = clampInt(env.ZHIYU_MEMORY_DEADLINE_MS, 2500, 0, 30_000);
  const wiredMemoryBlock =
    memoryBlock ??
    (async ({ sender, query }) => {
      if (!sender || sender.kind !== "user" || !sender.ref) return "";
      if (memoryDeadlineMs === 0) return "";
      let timer = null;
      const read = chatMemoryBlockFor(sender.ref, query, env).finally(() => clearTimeout(timer));
      const { block } = await Promise.race([
        read,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ block: "" }), memoryDeadlineMs);
        }),
      ]);
      return block;
    });
  // ── The room commander (add-room-commander) ────────────────────────────────
  //
  // Supplied through the SAME `voiceRoute` seam the router has carried since
  // add-voice-routing 3.1 — which until now had no supplier, so every room
  // broadcast ("each may reply or pass") and a round where everyone declined
  // produced nothing (2026-11-19: 44s of dead air in a customer group).
  //
  // Off by default: without the switch, `voiceRoute` stays exactly as injected
  // and the router behaves byte-for-byte as before.
  const commanderOn = () => ["1", "true", "yes"].includes(String(env.ZHIYU_ROOM_COMMANDER || "").toLowerCase());
  // 12s was measured against the WRONG baseline: a full seat turn takes 16-32s on
  // this deployment, and the commander shares the same ACP lane — connection setup
  // plus first token alone eats most of 12s. Every live turn hit `commander
  // timeout`, so the 12s bound made the commander a no-op in production while
  // passing every test (2026-11-19). 45s is above the observed ceiling and still
  // far below the platform's 5-minute turn cap.
  const commanderTimeoutMs = Number(env.ZHIYU_COMMANDER_TIMEOUT_MS || 45_000);
  const commander = createCommander({
    enabled: commanderOn,
    log: console,
    timeoutMs: commanderTimeoutMs,
    // The group hears "received" the moment routing starts — not after the model
    // answers. This is the one part of the wait that can be eliminated outright.
    onThinking: ({ room }) => {
      store.messageAppend({
        roomId: room.id,
        kind: "system",
        content: "",
        visibility: "shared",
        meta: { event: "commander_receipt", phase: "thinking" },
      });
    },
    callCommander: async (prompt, { seats = [] } = {}) => {
      // The commander must run on a DEPLOYMENT that actually exists. An invented
      // ref (`__commander__`) has no deployment behind it, so the lane refuses
      // with "agent seat has no live deployment" — measured on the first live
      // turn, 2026-11-19. It borrows the first present seat's deployment and the
      // prompt says it is acting as commander; the seat gets no turn of its own.
      const host = seats[0];
      if (!host) throw new Error("no seat available to host the commander");
      const { text } = await (callAgent ?? missingLane)(
        { ref: host.ref, display: host.display || "指挥官", kind: host.kind ?? "agent" },
        { text: prompt, contextId: `room-commander:${host.ref}` },
      );
      return text;
    },
  });
  const wiredVoiceRoute = async (ctx) => {
    if (!commanderOn()) return typeof voiceRoute === "function" ? voiceRoute(ctx) : null;
    const decided = await commander(ctx);
    if (decided) return decided;
    // Commander failed → today's behaviour, with the degradation recorded so an
    // operator can tell "no commander" from "commander said nobody".
    try {
      store.messageAppend({
        roomId: ctx.room.id,
        kind: "event",
        content: "",
        visibility: "shared",
        meta: { event: "commander_degraded", reason: "decision unavailable" },
      });
    } catch { /* a trace row must never break the round */ }
    return typeof voiceRoute === "function" ? voiceRoute(ctx) : null;
  };

  const router = createRoomRouter({
    store,
    effectiveCap,
    callAgent: callAgent ?? missingLane,
    settleTurn,
    memoryBlock: wiredMemoryBlock,
    voiceRoute: wiredVoiceRoute,
    onBudgetWarning: (room, dayTurns, budget) =>
      notifyUser("budget_warning", {
        to: room.ownerEmail,
        roomId: room.id,
        roomTitle: room.title,
        dayTurns,
        budget,
      }),
    bus,
    attachmentBlock: ({ rows }) => buildAttachmentBlock({ rows, store, limits: attachments.limits }),
  });
  const humanMessageHook = onHumanMessage ?? router.onHumanMessage;

  // Website-embed posture (add-zhiyu-website-embed): every PUBLIC widget lane
  // is inert until the deployment opts in. Management routes stay live so
  // rooms can be configured before the public door opens.
  const widgetEnabled = ["1", "true", "yes"].includes(String(env.ZHIYU_WIDGET || "").toLowerCase());
  const guestSecret = secret || env.ZHIYU_GUEST_SECRET || "";
  const guestTtlSec = clampInt(env.ZHIYU_GUEST_TTL_HOURS, 72, 1, 720) * 3600;
  const siteBase = () => (env.PAAS_BASE_URL || "").replace(/\/+$/, "");

  // Rate buckets: widget loads per IP, guest messages per seat. Same in-memory
  // token-bucket posture as share.js (local to one gateway process).
  const buckets = new Map();
  function takeToken(key, limit, windowMs) {
    const now = Date.now();
    const b = buckets.get(key) ?? { n: limit, at: now };
    if (now - b.at >= windowMs) {
      b.n = limit;
      b.at = now;
    }
    if (b.n <= 0) {
      buckets.set(key, b);
      return false;
    }
    b.n -= 1;
    buckets.set(key, b);
    return true;
  }
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
    store.widgetNoncePurgeOlderThan(cutoff);
  }, 60_000).unref?.();

  const cookieHost = (req) => {
    const ref = String(req.headers.referer ?? req.headers.origin ?? "");
    try {
      return ref ? new URL(ref).host : null;
    } catch {
      return null;
    }
  };

  // Public widget auth wrapper: widget token → room → allowlist-by-referer.
  // Returns { row, room } or null after answering.
  // Public widget auth wrapper: widget token → TARGET → allowlist-by-referer.
  // Returns { row, room, account } or null after answering.
  //
  // Target resolution (add-zhiyu-team-account D1/D3): a token names either a
  // room (the pre-existing shape — every token whose accountId is null) or a
  // team account. A room target behaves byte-for-byte as before. An account
  // target opens (or reuses) a room for THIS visitor, so the visitor never has
  // to know a room id and the owner never re-mints a token per room.
  async function authorizeWidget(req, res, { requireHost = true, openRoom = true } = {}) {
    if (!widgetEnabled) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    const row = verifyWidgetToken(store, req.params.token);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    if (row.kind === "embed" && requireHost && !hostAllowed(row.allowlist, cookieHost(req) ?? req.body?.host)) {
      res.status(403).json({ error: "host not allowed" });
      return null;
    }
    // Room target: the legacy path, untouched.
    if (!row.accountId) {
      const room = store.roomGet(row.roomId);
      if (!room) {
        res.status(404).json({ error: "not found" });
        return null;
      }
      return { row, room, account: null };
    }
    // Account target.
    const account = store.teamAccountGet(row.accountId);
    // Revoked account or an account whose team no longer exists must fail the
    // same way an unknown token does — no oracle for "this account existed".
    if (!account || account.revokedAt) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    // Read-only lanes (stream/messages) resolve the visitor's EXISTING room and
    // never open a new one: a background poll must not spawn rooms.
    const existing = openRoom ? null : store.accountRoomForVisitor(account.id, guestRefFromRequest(req));
    const room = openRoom ? await ensureAccountRoom(req, account) : existing && store.roomGet(existing);
    if (!room) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return { row, room, account };
  }

  // The ref this visitor's pass names, if any. Used only to decide whether a
  // read-only request can resolve to a room — never to mint anything.
  function guestRefFromRequest(req) {
    const cookie = req.headers.cookie || "";
    const m = /(?:^|;\s*)zy_guest=([^;]+)/.exec(cookie);
    const presented = (m ? decodeURIComponent(m[1]) : null) ?? req.query.tty ?? req.body?.tty ?? null;
    const pass = presented && guestSecret ? verifyGuestPass(guestSecret, presented) : null;
    return pass?.ref ?? null;
  }

  // Open-or-reuse the room this visitor belongs in under a team account:
  //   1. the room this visitor was already seated in (same account), else
  //   2. any active room this account opened with a free seat, else
  //   3. a fresh room owned by the account's owner, with the account's defaults.
  // Rooms carry `accountId`, which is provenance only — authorization still
  // runs over membership rows, so an account can never read its other rooms
  // through a guest seat.
  async function ensureAccountRoom(req, account) {
    const ref = guestRefFromRequest(req);
    if (ref) {
      const prior = store.accountRoomForVisitor(account.id, ref);
      if (prior) {
        const room = store.roomGet(prior);
        if (room && room.status === "active") return room;
      }
    }
    const room = store.roomCreate({
      title: account.fleetName ? `${account.fleetName} · 接待` : "接待",
      ownerEmail: account.ownerEmail,
      idleMinutes: account.idleMinutes ?? 15,
      replyCap: account.replyCap ?? null,
      accountId: account.id,
    });
    // The room must arrive with the team's seats in it: an address nobody
    // answers at is worse than no address (the visitor cannot tell it apart
    // from an agent that is simply slow).
    await accountRoomSeeder?.current?.seat(account, room);
    return room;
  }

  // Guest seat by pass (cookie first, tty fallback): returns { member, tty }.
  // Member presence is derived from the pass signature — the pass names the
  // seat ref, we look it up; a stale or absent pass mints a NEW seat at visit
  // time (never silently merges two visitors).
  // Guest seat by pass (cookie first, tty fallback): returns { member, tty }.
  // Keyed on the RESOLVED room id, not the token row's: an account token has no
  // room of its own (rooms are opened on demand), so matching against
  // `row.roomId` would never find a returning visitor.
  function guestSeat(req, roomId) {
    const cookie = (req.headers.cookie || "");
    const m = /(?:^|;\s*)zy_guest=([^;]+)/.exec(cookie);
    const presented = (m ? decodeURIComponent(m[1]) : null) ?? req.query.tty ?? req.body?.tty ?? null;
    const pass = presented && guestSecret ? verifyGuestPass(guestSecret, presented) : null;
    if (pass && pass.roomId === roomId) {
      const member = store.memberFor(roomId, "guest", pass.ref);
      if (member && member.state === "active") return { member, tty: presented, reused: true };
    }
    return null;
  }

  function serveGuestPass(roomId, ref) {
    const exp = Math.floor(Date.now() / 1000) + guestTtlSec;
    const tty = signGuestPass(guestSecret, { roomId, ref, expSec: exp });
    return { tty, setCookie: `zy_guest=${encodeURIComponent(tty)}; Path=/; Max-Age=${guestTtlSec}; SameSite=None; Secure; HttpOnly` };
  }

  function clampInt(v, dflt, lo, hi) {
    const n = Number.parseInt(String(v ?? ""), 10);
    if (!Number.isInteger(n)) return dflt;
    return Math.min(Math.max(n, lo), hi);
  }

  // Idle auto-close horizon (fix-zhiyu-permanent-rooms D1): `idleMinutes` used
  // to be capped at 1440 (one day), so no room could outlive a quiet day — a
  // standing team room died every night. `0` now means NEVER auto-close (the
  // sweep skips it), and the upper bound moves to a year for the finite values.
  // The sweep's own arithmetic (`last_activity_at + idle_minutes * 60000`) is
  // untouched: 0 can never exceed a timestamp, so "never" needs no special case
  // there, only the schema's NOT NULL stays satisfied.
  const IDLE_MINUTES_MAX = 525_600; // one year
  const IDLE_MINUTES_NEVER = 0;
  function normalizeIdleMinutes(v, dflt = 15) {
    const n = Number.parseInt(String(v ?? ""), 10);
    if (!Number.isInteger(n)) return dflt;
    if (n === IDLE_MINUTES_NEVER) return IDLE_MINUTES_NEVER;
    return Math.min(Math.max(n, 1), IDLE_MINUTES_MAX);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Authorization: resolve the caller and their seat(s) in one pass. Returns
  // null (after answering 404) when the room must be invisible to them.
  function authorize(req, res, roomId) {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    const room = store.roomGet(roomId);
    if (!room) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    const members = store.membersOf(roomId);
    const email = user.email;
    const myUser = members.find((m) => m.kind === "user" && m.ref === email && m.state === "active");
    const myFacade = members.find((m) => m.kind === "facade" && m.onBehalfOf === email && m.state === "active");
    const isOwner = room.ownerEmail === email;
    if (!isOwner && !myUser && !myFacade) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return { user, room, members, myUser, myFacade, isOwner };
  }

  // Emit a system/event row into the room stream (seq-ordered like messages).
  function emit(roomId, kind, content, meta) {
    return store.messageAppend({ roomId, kind, content: content ?? "", meta });
  }

  // Take-over flip (spec: 代席回路): the principal's user seat goes active
  // and their on-duty facade steps back to listening. Idempotent — flipping
  // an already-over seat emits nothing.
  function applyTakeOver(auth) {
    let flipped = false;
    if (auth.myUser && auth.myUser.presence !== "active") {
      store.memberSetPresence(auth.myUser.id, "active");
      flipped = true;
    }
    const facade = auth.members.find(
      (m) => m.kind === "facade" && m.onBehalfOf === auth.user.email && m.state === "active" && m.presence === "on_duty",
    );
    if (facade) {
      store.memberSetPresence(facade.id, "listening");
      flipped = true;
    }
    if (flipped) {
      emit(auth.room.id, "system", "", { event: "take_over", by: auth.user.email, facade: facade?.id ?? null });
    }
    return flipped;
  }

  // Notification lanes (group 8): the in-app unread inbox is ALWAYS on
  // (store-backed, per-user); opts.notify is an optional ops-side mirror —
  // unset by default. A facade's collected to-dos travel the EXISTING
  // matters queue, which is precisely the channel for that event class.
  const notifyUser = (type, payload) => {
    if (payload?.to) {
      store.notificationAdd({ email: payload.to, type, roomId: payload.roomId ?? null, payload });
    }
    try {
      notify?.(type, payload);
    } catch (err) {
      console.warn(`[zhiyu] notify mirror failed (${type}): ${err.message}`);
    }
  };

  // Room minutes (8.2): a mechanical digest of the room's shared stream —
  // participants, counts, closing tail — delivered to every member and to
  // each facade's principal. An LLM-authored summary lane is an apply-time
  // open question and can upgrade this payload without touching delivery.
  const endedHook = (room, reason) => {
    try {
      const members = store.membersOf(room.id).filter((m) => m.state !== "removed");
      const shared = store
        .messagesAfter(room.id, 0, { viewerMemberId: null, limit: 10_000 })
        .filter((m) => m.visibility === "shared" && (m.kind === "human" || m.kind === "agent"));
      const recipients = new Set(
        members.flatMap((m) => (m.kind === "user" ? [m.ref] : m.onBehalfOf ? [m.onBehalfOf] : [])),
      );
      const tail = shared.slice(-6).map((m) => ({ kind: m.kind, content: String(m.content).slice(0, 280) }));
      for (const email of recipients) {
        notifyUser("minutes", {
          to: email,
          roomId: room.id,
          roomTitle: room.title,
          reason,
          participants: members.map((m) => m.display || m.ref),
          messageCount: shared.length,
          tail,
        });
      }
    } catch (err) {
      console.warn(`[zhiyu] minutes digest failed for ${room?.id}: ${err.message}`);
    }
    try {
      onRoomEnded?.(room, reason);
    } catch (err) {
      console.warn(`[zhiyu] onRoomEnded hook failed for ${room?.id}: ${err.message}`);
    }
  };

  // Hand-back: the principal steps away and their facade resumes duty.
  function applyHandBack(auth) {
    const facade = auth.members.find((m) => m.kind === "facade" && m.onBehalfOf === auth.user.email && m.state === "active");
    if (!facade) return false;
    if (auth.myUser && auth.myUser.presence !== "away") store.memberSetPresence(auth.myUser.id, "away");
    if (facade.presence !== "on_duty") store.memberSetPresence(facade.id, "on_duty");
    emit(auth.room.id, "system", "", { event: "hand_back", by: auth.user.email, facade: facade.id });
    return true;
  }

  // Accept an invite: land the seat row(s) and stream the join. Facades pull
  // their principal's user seat in too (presence away) — the owner follows
  // their own 分身 into the room, which is also what gives them the private
  // window keyed on their member id.
  function acceptSeats(invite) {
    const member = store.memberEnsure({
      roomId: invite.roomId,
      kind: invite.kind,
      ref: invite.ref,
      onBehalfOf: invite.onBehalfOf,
      display: invite.display,
      historyGrant: invite.historyGrant,
      invitedBy: invite.invitedBy,
      // 音色随邀请落到座席（add-room-voice-and-catalog）：召唤时从岗位声明带来。
      voice: invite.voice ?? null,
    });
    if (member.state !== "active") store.memberSetState(member.id, "active");
    // A seat that already existed before the invite (re-invite of a former
    // member) keeps its own row; stamp the summon's voice only when the seat has
    // none of its own — a per-seat override set in the room always wins.
    if (invite.voice && !member.voice) store.memberSetVoice(member.id, invite.voice);
    if (invite.kind === "facade") {
      store.memberEnsure({
        roomId: invite.roomId,
        kind: "user",
        ref: invite.onBehalfOf,
        display: invite.onBehalfOf,
        presence: "away",
        invitedBy: invite.invitedBy,
        historyGrant: invite.historyGrant,
      });
    }
    emit(invite.roomId, "system", "", { event: "member_joined", member: store.memberById(member.id) });
    return member;
  }

  // Liveness for the module itself — same public-by-design posture as
  // /healthz, carries no per-user information.
  app.get("/api/zhiyu/health", (_req, res) => {
    res.json({ ok: true, module: "zhiyu" });
  });

  // Deployment-visible config probe: cap bounds + deployment default.
  app.get("/api/zhiyu/config", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    res.json({ replyCap });
  });

  // ── Rooms: create / hatch / list / read / patch ────────────────────────────

  app.post("/api/zhiyu/rooms", express.json({ limit: "32kb" }), async (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const title = String(req.body?.title ?? "").trim().slice(0, 120);
    const idleMinutes = req.body?.idleMinutes === undefined ? 15 : normalizeIdleMinutes(req.body.idleMinutes, 15);
    const replyCapBody = req.body?.replyCap;
    let cap = null;
    if (replyCapBody !== undefined && replyCapBody !== null) {
      const n = Number(replyCapBody);
      if (!Number.isInteger(n) || n < replyCap.min || n > replyCap.max) {
        return res.status(400).json({ error: `replyCap must be an integer within ${replyCap.min}..${replyCap.max}` });
      }
      cap = n;
    }

    // Hatch (升为空间): the owner pulls a transcript window out of their own
    // cell session; the room seeds from it with provenance, the original
    // session is only ever read (design D-F).
    const hatch = req.body?.hatch;
    let seed = null;
    if (hatch && typeof hatch === "object" && hatch.sessionId) {
      if (!cellExport) return res.status(503).json({ error: "hatch lane not configured on this deployment" });
      const window = String(hatch.window ?? "").trim();
      if (!window) return res.status(400).json({ error: "hatch.window required: 'all' or 'last:<1..1000>'" });
      try {
        seed = await cellExport(user, String(hatch.sessionId), window);
      } catch (err) {
        const status = err?.status === 403 || err?.status === 404 ? err.status : 502;
        return res.status(status).json({ error: `could not export session: ${err.message}` });
      }
    }

    const budgetBody = req.body?.dailyBudgetTurns;
    let budget = null;
    if (budgetBody !== undefined && budgetBody !== null) {
      const b = Number(budgetBody);
      if (!Number.isInteger(b) || b < 1 || b > 100_000) {
        return res.status(400).json({ error: "dailyBudgetTurns must be an integer within 1..100000" });
      }
      budget = b;
    }
    const room = store.roomCreate({
      title: title || (seed?.title ? `${seed.title}` : ""),
      ownerEmail: user.email,
      idleMinutes,
      replyCap: cap,
      sourceSession: seed?.sessionId ?? null,
    });
    if (budget !== null) store.roomSetDailyBudget(room.id, budget);
    const ownerMember = store.memberAdd({
      roomId: room.id,
      kind: "user",
      ref: user.email,
      display: user.email,
      invitedBy: user.email,
    });
    if (seed) {
      for (const m of seed.messages ?? []) {
        store.messageAppend({
          roomId: room.id,
          kind: m.role === "assistant" ? "agent" : "human",
          fromAgent: m.role === "assistant" ? 1 : 0,
          content: m.content ?? "",
          provenance: `session:${seed.sessionId}`,
          meta: { event: "hatched_history", role: m.role, window: seed.window },
        });
      }
      emit(room.id, "system", "", { event: "room_hatched", sourceSession: seed.sessionId, window: seed.window, count: seed.messages?.length ?? 0 });
    } else {
      emit(room.id, "system", "", { event: "room_created", by: user.email });
    }
    res.json({ room: store.roomGet(room.id), members: store.membersOf(room.id), myMemberId: ownerMember.id, effectiveReplyCap: effectiveCap(store.roomGet(room.id)) });
  });

  app.get("/api/zhiyu/rooms", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const rooms = store.roomListFor(user.email).map((r) => ({ ...r, effectiveReplyCap: effectiveCap(r) }));
    res.json({ rooms });
  });

  app.get("/api/zhiyu/rooms/:id", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    res.json({
      room: { ...auth.room, effectiveReplyCap: effectiveCap(auth.room) },
      members: auth.members,
      myMemberId: auth.myUser?.id ?? null,
    });
  });

  app.patch("/api/zhiyu/rooms/:id", express.json({ limit: "16kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const patch = {};
    const events = [];
    if (req.body?.title !== undefined) {
      patch.title = String(req.body.title).trim().slice(0, 120);
      events.push({ event: "room_renamed", title: patch.title });
    }
    if (req.body?.replyCap !== undefined) {
      if (req.body.replyCap === null) {
        patch.replyCap = null;
        events.push({ event: "reply_cap_changed", replyCap: null, effective: replyCap.default });
      } else {
        const n = Number(req.body.replyCap);
        if (!Number.isInteger(n) || n < replyCap.min || n > replyCap.max) {
          return res.status(400).json({ error: `replyCap must be an integer within ${replyCap.min}..${replyCap.max}`, bounds: replyCap });
        }
        patch.replyCap = n;
        events.push({ event: "reply_cap_changed", replyCap: n, effective: n });
      }
    }
    // Session scope (zhiyu-room-session-scope 1.4). An unrecognised value is
    // REFUSED rather than coerced: a typo must not silently partition people's
    // memories, and it must not silently keep sharing them either — the owner
    // needs to know the setting did not take.
    if (req.body?.sessionScope !== undefined) {
      const scope = req.body.sessionScope;
      if (scope !== null && scope !== "shared" && scope !== "per-sender") {
        return res.status(400).json({ error: 'sessionScope must be "shared", "per-sender", or null' });
      }
      patch.sessionScope = scope;
      events.push({ event: "session_scope_changed", scope: scope ?? "shared" });
    }
    if (req.body?.contextWindow !== undefined) {
      const raw = req.body.contextWindow;
      if (raw === null) patch.contextWindow = null;
      else {
        const n = Number(raw);
        // A window of 0 would mean "see nothing", which produces confident
        // answers with no context — the worst possible failure mode.
        if (!Number.isInteger(n) || n < 4 || n > 500) {
          return res.status(400).json({ error: "contextWindow must be an integer within 4..500, or null" });
        }
        patch.contextWindow = n;
      }
    }
    if (req.body?.idleMinutes !== undefined) {
      const n = Number(req.body.idleMinutes);
      // Same horizon as create (fix-zhiyu-permanent-rooms D1): 0 = never close,
      // otherwise 1..525600. The old 1..1440 wall made a standing room
      // impossible to keep, which is exactly what a team room needs.
      if (!Number.isInteger(n) || n < 0 || n > IDLE_MINUTES_MAX) {
        return res.status(400).json({
          error: `idleMinutes must be 0 (never auto-close) or an integer within 1..${IDLE_MINUTES_MAX}`,
          neverValue: IDLE_MINUTES_NEVER,
          max: IDLE_MINUTES_MAX,
        });
      }
      patch.idleMinutes = n === IDLE_MINUTES_NEVER ? IDLE_MINUTES_NEVER : Math.max(n, 1);
    }
    if (req.body?.dailyBudgetTurns !== undefined) {
      if (req.body.dailyBudgetTurns === null) {
        store.roomSetDailyBudget(auth.room.id, null);
        events.push({ event: "budget_changed", dailyBudgetTurns: null });
      } else {
        const b = Number(req.body.dailyBudgetTurns);
        if (!Number.isInteger(b) || b < 1 || b > 100_000) {
          return res.status(400).json({ error: "dailyBudgetTurns must be an integer within 1..100000" });
        }
        store.roomSetDailyBudget(auth.room.id, b);
        events.push({ event: "budget_changed", dailyBudgetTurns: b });
      }
    }
    if (req.body?.proactiveGreeting !== undefined) {
      const v = req.body.proactiveGreeting;
      if (typeof v !== "boolean") return res.status(400).json({ error: "proactiveGreeting must be boolean" });
      store.roomSetProactiveGreeting(auth.room.id, v);
      events.push({ event: "proactive_greeting_toggled", enabled: v });
    }
    // Showcase mode (declare-zhiyu-keyless-showcase-rooms): an explicit,
    // owner-set declaration that this room runs on free quota on purpose, so a
    // keyless seat's turn is "expected unbilled" rather than a config gap.
    if (req.body?.billingMode !== undefined) {
      const v = req.body.billingMode;
      if (v !== "billed" && v !== "showcase") {
        return res.status(400).json({ error: "billingMode must be 'billed' or 'showcase'" });
      }
      patch.billingMode = v;
      events.push({ event: "billing_mode_changed", billingMode: v });
    }
    const room = store.roomPatch(auth.room.id, patch);
    for (const meta of events) emit(auth.room.id, "system", "", meta);
    res.json({ room: { ...room, effectiveReplyCap: effectiveCap(room) } });
  });

  // ── Invites ───────────────────────────────────────────────────────────────

  // Mine: the invites I can act on (as invited user or as a facade/agent
  // seat's principal).
  app.get("/api/zhiyu/invites", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const invites = store.invitesPendingForPrincipal(user.email).map((v) => ({
      ...v,
      room: store.roomGet(v.roomId) ? { id: v.roomId, title: store.roomGet(v.roomId).title } : null,
    }));
    res.json({ invites });
  });

  app.post("/api/zhiyu/rooms/:id/invites", express.json({ limit: "16kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    // Any active member may invite (the授权 default); removal stays owner-only.
    if (!auth.myUser && !auth.isOwner) return res.status(403).json({ error: "active member required" });

    const kind = String(req.body?.kind ?? "");
    if (!["user", "facade", "agent"].includes(kind)) return res.status(400).json({ error: "kind must be user|facade|agent" });
    // Case rules: user refs are emails (canonical lowercase); facade/agent
    // refs are deployment ids `${packId}:${agentId}` and are CASE-SENSITIVE —
    // deployment bookkeeping matches by exact packId (learned the hard way on
    // the first live dispatch: lowercasing broke resolution for mixed-case
    // pack ids).
    const ref = kind === "user" ? String(req.body?.ref ?? "").trim().toLowerCase() : String(req.body?.ref ?? "").trim();
    if (!ref) return res.status(400).json({ error: "ref required" });
    const onBehalfOf = req.body?.onBehalfOf ? String(req.body.onBehalfOf).trim().toLowerCase() : null;
    if (kind === "facade" && !onBehalfOf) return res.status(400).json({ error: "facade invites require onBehalfOf (the principal)" });
    if (!/^[A-Za-z0-9._:@/-]+$/.test(ref)) return res.status(400).json({ error: "ref has invalid characters" });
    const historyGrant = req.body?.historyGrant === "full" ? "full" : "join_from";
    const display = String(req.body?.display ?? ref).slice(0, 120);

    // Already seated?
    const seated = store.memberFor(auth.room.id, kind, ref);
    if (seated && seated.state === "active") return res.status(409).json({ error: "already a member", member: seated });

    // A facade's invitation answers by its principal's policy (spec: 在席成员
    // 与邀请握手): auto_accept lands immediately, ask stays pending, decline
    // resolves declined at once.
    let policy = null;
    if (kind === "facade") {
      policy = store.ownerPolicyGet(onBehalfOf).facadeInvite ?? "ask";
    }
    const idemBase = `${auth.room.id}:${kind}:${ref}`;
    let idemKey = typeof req.body?.idemKey === "string" && req.body.idemKey.trim() ? req.body.idemKey.trim() : idemBase;
    if (store.invitesForRoom(auth.room.id).some((v) => v.idemKey === idemKey)) idemKey = `${idemBase}:${Date.now().toString(36)}`;
    const { invite, replay } = store.inviteCreate({
      roomId: auth.room.id,
      kind,
      ref,
      onBehalfOf,
      display,
      historyGrant,
      invitedBy: auth.user.email,
      idemKey,
    });

    if (!replay && invite.state === "pending") {
      if (policy === "auto_accept") {
        acceptSeats(invite);
        store.inviteResolve(invite.id, "accepted");
        return res.json({ invite: store.inviteGet(invite.id), members: store.membersOf(auth.room.id), policy });
      }
      if (policy === "decline") {
        store.inviteResolve(invite.id, "declined");
        emit(auth.room.id, "event", "", { event: "invite_auto_declined", kind, ref, by: "owner_policy" });
        return res.json({ invite: store.inviteGet(invite.id), members: store.membersOf(auth.room.id), policy });
      }
      emit(auth.room.id, "system", "", { event: "invite_sent", kind, ref, display, by: auth.user.email });
      notifyUser("invite", { to: onBehalfOf ?? ref, roomId: auth.room.id, roomTitle: auth.room.title, kind, display, invitedBy: auth.user.email });
    }
    res.json({ invite, members: store.membersOf(auth.room.id), policy });
  });

  const resolveInviteAction = (verdict) => (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const invite = store.inviteGet(req.params.inviteId);
    if (!invite || invite.state !== "pending") return res.status(404).json({ error: "not found" });
    const mine =
      (invite.kind === "user" && invite.ref === user.email) ||
      ((invite.kind === "facade" || invite.kind === "agent") && invite.onBehalfOf === user.email);
    if (!mine) return res.status(404).json({ error: "not found" });
    if (verdict === "accepted") {
      const member = acceptSeats(invite);
      store.inviteResolve(invite.id, "accepted");
      // The invite's own notice clears with the decision (polish-web-surfaces,
      // zhiyu-room 通知与触达) — resolving the invite must not leave the badge lit.
      store.notificationMarkReadBy(user.email, { type: "invite", roomId: invite.roomId });
      emit(invite.roomId, "system", "", { event: "invite_accepted", kind: invite.kind, ref: invite.ref });
      return res.json({ invite: store.inviteGet(invite.id), member });
    }
    store.inviteResolve(invite.id, "declined");
    store.notificationMarkReadBy(user.email, { type: "invite", roomId: invite.roomId });
    emit(invite.roomId, "event", "", { event: "invite_declined", kind: invite.kind, ref: invite.ref, by: user.email });
    res.json({ invite: store.inviteGet(invite.id) });
  };
  app.post("/api/zhiyu/invites/:inviteId/accept", resolveInviteAction("accepted"));
  app.post("/api/zhiyu/invites/:inviteId/decline", resolveInviteAction("declined"));

  // Per-owner facade invitation policy (auto_accept | ask | decline).
  app.put("/api/zhiyu/policies/facade", express.json({ limit: "8kb" }), (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const policy = String(req.body?.facadeInvite ?? "");
    if (!["auto_accept", "ask", "decline"].includes(policy)) {
      return res.status(400).json({ error: "facadeInvite must be auto_accept|ask|decline" });
    }
    res.json({ policies: store.ownerPolicySet(user.email, { facadeInvite: policy }) });
  });
  app.get("/api/zhiyu/policies", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    res.json({ policies: { facadeInvite: "ask", ...store.ownerPolicyGet(user.email) } });
  });

  // ── Members: leave / remove / owner transfer cascade ───────────────────────

  app.post("/api/zhiyu/rooms/:id/leave", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const roomId = auth.room.id;
    // Leaving takes the caller's user seat AND any facade seat they own out
    // of the room — the room must never keep a 分身 whose principal walked.
    const seats = auth.members.filter(
      (m) => m.state === "active" && ((m.kind === "user" && m.ref === auth.user.email) || (m.kind === "facade" && m.onBehalfOf === auth.user.email)),
    );
    for (const s of seats) {
      store.memberSetState(s.id, "left");
      emit(roomId, "system", "", { event: "member_left", member: { id: s.id, kind: s.kind, display: s.display } });
    }
    let room = store.roomGet(roomId);
    if (auth.isOwner && room.status === "active") {
      const heirs = store.membersOf(roomId).filter((m) => m.kind === "user" && m.state === "active");
      if (heirs.length) {
        room = store.roomTransferOwner(roomId, heirs[0].ref);
        emit(roomId, "system", "", { event: "owner_transferred", to: heirs[0].ref });
      } else {
        room = store.roomSetStatus(roomId, "ended");
        emit(roomId, "system", "", { event: "room_ended", reason: "owner_left" });
        void endedHook(store.roomGet(roomId), "owner_left");
      }
    }
    res.json({ ok: true, room });
  });

  app.post("/api/zhiyu/rooms/:id/remove", express.json({ limit: "8kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const target = store.memberById(String(req.body?.memberId ?? ""));
    if (!target || target.roomId !== auth.room.id) return res.status(404).json({ error: "member not found" });
    store.memberSetState(target.id, "removed");
    emit(auth.room.id, "system", "", { event: "member_removed", member: { id: target.id, kind: target.kind, display: target.display }, by: auth.user.email });
    res.json({ ok: true, members: store.membersOf(auth.room.id) });
  });

  app.post("/api/zhiyu/rooms/:id/end", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const room = store.roomSetStatus(auth.room.id, "ended");
    emit(auth.room.id, "system", "", { event: "room_ended", reason: "owner_ended", by: auth.user.email });
    void endedHook(room, "owner_ended");
    res.json({ room });
  });

  // ── Notifications inbox (站内未读 lane) ────────────────────────────────────

  app.get("/api/zhiyu/notifications", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    res.json({
      notifications: store.notificationsFor(user.email, { unreadOnly }),
      unread: store.notificationUnreadCount(user.email),
    });
  });

  app.post("/api/zhiyu/notifications/:nid/read", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    store.notificationMarkRead(user.email, req.params.nid);
    res.json({ ok: true, unread: store.notificationUnreadCount(user.email) });
  });

  // Clear the whole unread lane (openspec: polish-web-surfaces, zhiyu-room
  // 通知与触达). The client calls this on entering the zhiyu page, so the nav
  // badge has a deterministic path to zero. Returns the fresh count so the
  // client can clear the badge immediately instead of waiting for a poll.
  app.post("/api/zhiyu/notifications/read-all", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    store.notificationMarkAllRead(user.email);
    res.json({ ok: true, unread: store.notificationUnreadCount(user.email) });
  });

  // ── Duty circuit: take-over / hand-back / call ─────────────────────────────

  app.post("/api/zhiyu/rooms/:id/takeover", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const flipped = applyTakeOver(auth);
    res.json({ ok: true, flipped, members: store.membersOf(auth.room.id) });
  });

  app.post("/api/zhiyu/rooms/:id/handback", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!applyHandBack(auth)) return res.status(409).json({ error: "no facade of yours in this room to hand back to" });
    res.json({ ok: true, members: store.membersOf(auth.room.id) });
  });

  // 呼叫: summon a member's principal back. Streams needs_you, fires the
  // notification hook, and — when the principal's facade is on duty — has the
  // 分身 itself say in-room that its human was called (spec: 呼叫本人).
  app.post("/api/zhiyu/rooms/:id/call", express.json({ limit: "8kb" }), async (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    const target = String(req.body?.target ?? "").trim().toLowerCase();
    if (!target || !/^[^@\s]+@[^@\s]+$/.test(target)) return res.status(400).json({ error: "target email required" });
    const targetUser = auth.members.find((m) => m.kind === "user" && m.ref === target && m.state === "active");
    const targetFacade = auth.members.find((m) => m.kind === "facade" && m.onBehalfOf === target && m.state === "active");
    if (!targetUser && !targetFacade) return res.status(404).json({ error: "target is not a member of this room" });
    // The notification carries the room and the POSITION of the needs_you row
    // (add-zhiyu-mobile-clients 6.1): tapping it opens the room scrolled to this
    // seq. `from` is the caller's address — the recipient already sees it in the
    // room — and nothing of the conversation travels: a push renders on a lock
    // screen, so the template is an allowlist (packages/core/notification-deeplink).
    const needsYou = emit(auth.room.id, "system", "", { event: "needs_you", to: target, from: auth.user.email });
    notifyUser("call", {
      to: target,
      roomId: auth.room.id,
      roomTitle: auth.room.title,
      from: auth.user.email,
      seq: needsYou?.seq ?? null,
    });
    if (targetFacade?.presence === "on_duty") {
      void Promise.resolve(
        router.directiveTurn({
          room: auth.room,
          targetRef: targetFacade.ref,
          directive: `请只用一句话向空间说明：你已呼叫你的主人 ${target}，正等他/她本人回来看这句话。称谓用「我主人」。`,
        }),
      ).catch((err) => console.error(`[zhiyu] call directive failed for ${auth.room.id}:`, err.message));
    }
    res.json({ ok: true });
  });

  // ── Messages & live stream ─────────────────────────────────────────────────

  // The private window send face (add-zhiyu-private-window-send): a member
  // exchanges with their OWN duty facade — every row lands on the member's
  // private档 (never the shared stream), the facade's answer rides the same
  // 档 through dispatchPrivateTurn, and guests/non-members have no user seat
  // to reach it. Absent facade → readable refusal, nothing persisted.
  app.post("/api/zhiyu/rooms/:id/private", express.json({ limit: "16kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    if (!auth.myUser) return res.status(403).json({ error: "active user seat required" });
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content required" });
    if (content.length > 16_000) return res.status(400).json({ error: "content too long" });
    const facade = store
      .membersOf(auth.room.id)
      .find((m) => m.kind === "facade" && m.onBehalfOf === auth.myUser.ref && m.state === "active");
    if (!facade) {
      return res.status(409).json({ error: "值守分身未在场——先入场或呼叫分身后再用私窗" });
    }
    const { row } = store.messageAppend({
      roomId: auth.room.id,
      kind: "human",
      senderMemberId: auth.myUser.id,
      visibility: `private:${auth.myUser.id}`,
      content,
    });
    applyTakeOver(auth);
    void Promise.resolve(
      router.dispatchPrivateTurn({ room: auth.room, sender: auth.myUser, message: row }),
    ).catch((err) => console.error(`[zhiyu] private turn failed for ${auth.room.id}:`, err));
    res.json({ message: row });
  });

  // ── routing trail: undo / reassign (add-voice-routing 4.3/4.4 entry points) ─
  //
  // Owner-only: a routing decision is a room-wide act, so moving it is the
  // owner's call — not any member's. The human who spoke is second: their words
  // are theirs. Everything is recorded with `by`, and the original
  // `route_decision` row is never edited (4.4).
  const canReroute = (auth) => Boolean(auth?.isOwner) || auth?.myUser?.kind === "human";
  app.post("/api/zhiyu/rooms/:id/dispatch/:seq/cancel", express.json({ limit: "4kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!canReroute(auth)) return res.status(403).json({ error: "房间所有者或发言人才能改派" });
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq <= 0) return res.status(400).json({ error: "bad seq" });
    const out = router.cancelDispatch({ roomId: auth.room.id, triggerSeq: seq, by: auth.myUser?.ref ?? auth.user?.email ?? null });
    res.json(out);
  });
  app.post("/api/zhiyu/rooms/:id/dispatch/:seq/reassign", express.json({ limit: "8kb" }), async (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!canReroute(auth)) return res.status(403).json({ error: "房间所有者或发言人才能改派" });
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq <= 0) return res.status(400).json({ error: "bad seq" });
    const targets = Array.isArray(req.body?.targets) ? req.body.targets.map(String).slice(0, 20) : [];
    if (!targets.length) return res.status(400).json({ error: "targets required" });
    const out = await router.reassignDispatch({
      room: auth.room,
      triggerSeq: seq,
      targets,
      reason: String(req.body?.reason ?? "").slice(0, 300),
      by: auth.myUser?.ref ?? auth.user?.email ?? null,
    });
    if (!out.ok) return res.status(409).json(out);
    res.json(out);
  });

  // ── Meeting capture (add-meeting-capture) ──────────────────────────────────
  // A meeting is the container for several one-person capture streams. These
  // four routes own its lifecycle; they never touch the capture store (which
  // lives in the platform) — they only record WHO claimed which stream.
  //
  // The one thing these routes must never do is trust a client-supplied
  // identity: the member is always re-resolved from this room's own member
  // list, so "joined" cannot become a claim.

  // The room's "is anything on right now" face (add-meeting-discovery).
  //
  // A meeting was joinable only by the person who opened it, in the page where
  // they opened it: the panel started from `meeting = null` and the store's
  // meetingsOf/meetingOpenForMember had no route at all. So a second person in
  // the room could not SEE the meeting and therefore could not join — the
  // capability's whole point. This route is that missing half: read-only, room
  // members only, and it names the ONE meeting it means.
  //
  // Several meetings can be open in one room at the same time (allowed today),
  // so the pick must be deterministic: newest first, id as the tie-break. Two
  // clients that disagree about "the open meeting" would walk into two different
  // meetings while believing they were in one.
  app.get("/api/zhiyu/rooms/:id/meetings/open", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const open = store
      .meetingsOf(auth.room.id)
      .filter((m) => m.status === "open")
      .sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
    const meeting = open[0] ?? null;
    if (!meeting) return res.json({ meeting: null, participant: null });
    // "Am I already in it" is answered from THIS room's membership, never from
    // a client-supplied ref (same discipline as join itself).
    const ref = auth.myUser?.ref ?? auth.user?.email ?? null;
    const mine = ref
      ? store.meetingParticipants(meeting.id).find((p) => p.memberRef === ref) ?? null
      : null;
    res.json({ meeting, participant: mine });
  });

  app.post("/api/zhiyu/rooms/:id/meetings", express.json({ limit: "8kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    const title = String(req.body?.title ?? "").slice(0, 120);
    const meeting = store.meetingCreate({ roomId: auth.room.id, title, ownerEmail: auth.user.email });
    emit(auth.room.id, "system", "", {
      event: "meeting_opened",
      meetingId: meeting.id,
      title: meeting.title,
      by: auth.user.email,
    });
    res.status(201).json({ meeting });
  });

  app.post("/api/zhiyu/meetings/:id/join", express.json({ limit: "4kb" }), (req, res) => {
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "not found" });
    const auth = authorize(req, res, meeting.roomId);
    if (!auth) return;
    if (meeting.status !== "open") {
      return res.status(409).json({ error: "meeting ended", code: "meeting_not_open" });
    }
    // The joining seat must be a real USER seat in this room: a facade riding
    // for someone is not that person attending.
    if (!auth.myUser) return res.status(403).json({ error: "active user seat required" });
    const { participant, created } = store.meetingJoin({
      meetingId: meeting.id,
      member: { id: auth.myUser.id, ref: auth.myUser.ref },
    });
    if (created) {
      emit(auth.room.id, "system", "", {
        event: "meeting_joined",
        meetingId: meeting.id,
        member: { id: auth.myUser.id, display: auth.myUser.display || auth.myUser.ref },
      });
    }
    res.json({ meeting, participant, created });
  });

  // The stream's audio lives in the platform; this records the link so the
  // meeting view can say which participant owns which capture.
  app.post("/api/zhiyu/meetings/:id/capture", express.json({ limit: "4kb" }), (req, res) => {
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "not found" });
    const auth = authorize(req, res, meeting.roomId);
    if (!auth) return;
    if (!auth.myUser) return res.status(403).json({ error: "active user seat required" });
    const captureId = String(req.body?.captureId ?? "").trim();
    if (!captureId) return res.status(400).json({ error: "captureId required" });
    const existing = store.meetingParticipants(meeting.id).find((p) => p.memberRef === auth.myUser.ref);
    if (!existing) return res.status(409).json({ error: "join the meeting first", code: "not_joined" });
    const participant = store.meetingSetCapture({
      meetingId: meeting.id,
      memberRef: auth.myUser.ref,
      captureId,
    });
    res.json({ participant });
  });

  app.post("/api/zhiyu/meetings/:id/end", express.json({ limit: "4kb" }), (req, res) => {
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "not found" });
    const auth = authorize(req, res, meeting.roomId);
    if (!auth) return;
    // Ending is the owner's (or a participant's) call: it stops new joins only,
    // and it never deletes a capture (design D6).
    const isParticipant = store.meetingParticipants(meeting.id).some((p) => p.memberRef === auth.user.email);
    if (!auth.isOwner && !isParticipant) {
      return res.status(403).json({ error: "only the room owner or a participant may end the meeting" });
    }
    const ended = store.meetingEnd(meeting.id);
    if (ended.status === "ended" && meeting.status === "open") {
      emit(auth.room.id, "system", "", { event: "meeting_ended", meetingId: ended.id, by: auth.user.email });
    }
    res.json({ meeting: ended });
  });

  app.get("/api/zhiyu/meetings/:id", (req, res) => {
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "not found" });
    const auth = authorize(req, res, meeting.roomId);
    if (!auth) return;
    const participants = store.meetingParticipants(meeting.id);
    const rows = store.messagesAfter(meeting.roomId, 0, { viewerMemberId: auth.myUser?.id ?? null, limit: 5000 });
    const mine = rows.filter((m) => m?.meta?.capture?.meetingId === meeting.id);
    res.json({
      meeting,
      participants,
      // Read face: how many messages this meeting produced, and how many are
      // still waiting for a human to say who spoke. Arrival order, not a strict
      // cross-device timeline (design D5) — the field name says so.
      delivered: mine.length,
      awaitingConfirmation: rows.filter(
        (m) => m?.meta?.event === "route_decision" && m?.meta?.kind === "needs_confirmation",
      ).length,
      orderBasis: "arrival",
    });
  });

  app.post("/api/zhiyu/rooms/:id/messages", express.json({ limit: "32kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    // Posting needs an active USER seat — a purely facade-riding principal
    // has one by construction (acceptSeats creates it), so the gate here is
    // membership itself, and SPEAKING is itself take-over: presence flips to
    // active and an on-duty facade of theirs steps back to listening
    // (group 6's explicit take-over button rides the same flip).
    if (!auth.myUser) return res.status(403).json({ error: "active user seat required" });
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content required" });
    if (content.length > 16_000) return res.status(400).json({ error: "content too long" });
    const replyToSeq = Number.isInteger(req.body?.replyToSeq) ? req.body.replyToSeq : null;
    // Speaking is implicit take-over; the explicit button below rides the
    // same flip without a message.
    applyTakeOver(auth);
    const { row } = store.messageAppend({
      roomId: auth.room.id,
      kind: "human",
      senderMemberId: auth.myUser.id,
      content,
      replyToSeq,
    });
    // The round router rides this seam; fire-and-forget with a loud failure
    // so a router bug never eats the human's message silently.
    void Promise.resolve(humanMessageHook({ room: auth.room, member: auth.myUser, message: row })).catch((err) => {
      console.error(`[zhiyu] round router failed for ${auth.room.id}:`, err);
    });
    res.json({ message: row });
  });

  // Message history (spec: 消息流与发送者归因 — bidirectional windows).
  //   (bare)        = after=0, kept for existing callers/scripts
  //   ?after=N      = rows with seq > N (live cursor / reconnect)
  //   ?tail=N       = the last N visible rows, ascending (first screen)
  //   ?before=N     = rows with seq < N, ascending (load earlier)
  // `limit` is explicit, capped at MESSAGE_PAGE_MAX. Windows are mutually
  // exclusive; mixing them is a caller bug, so it answers 400 instead of
  // silently picking one.
  const MESSAGE_PAGE_DEFAULT = 200;
  const MESSAGE_PAGE_MAX = 500;

  /**
   * The ONE reader of a room window (add-zhiyu-mobile-clients 1.1/1.3).
   *
   * Paging, live streaming and the polling transport all have to answer the same
   * question — "which rows may THIS viewer see after this cursor" — and if each
   * transport answers it separately they will eventually disagree, leaking one
   * viewer's private window or hiding their own. So the choice lives here and
   * every transport calls it.
   */
  const readWindow = ({ roomId, viewerMemberId, after, before, tail, limit }) => {
    const scope = { viewerMemberId: viewerMemberId ?? null, limit };
    if (tail !== undefined) return store.messagesTail(roomId, Math.min(Math.floor(Number(tail)) || limit, MESSAGE_PAGE_MAX), scope);
    if (before !== undefined) return store.messagesBefore(roomId, Number(before) || 0, scope);
    return store.messagesAfter(roomId, Number(after ?? 0) || 0, scope);
  };
  app.get("/api/zhiyu/rooms/:id/messages", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const has = (k) => req.query[k] !== undefined && req.query[k] !== "";
    if ((has("after") && has("before")) || (has("after") && has("tail")) || (has("before") && has("tail"))) {
      return res.status(400).json({ error: "after, before and tail are mutually exclusive" });
    }
    const rawLimit = has("limit") ? Number(req.query.limit) : MESSAGE_PAGE_DEFAULT;
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return res.status(400).json({ error: "limit must be a positive number" });
    }
    const limit = Math.min(Math.floor(rawLimit), MESSAGE_PAGE_MAX);
    const messages = readWindow({
      roomId: auth.room.id,
      viewerMemberId: auth.myUser?.id ?? null,
      ...(has("tail") ? { tail: req.query.tail } : {}),
      ...(has("before") ? { before: req.query.before } : {}),
      ...(has("after") ? { after: req.query.after } : {}),
      limit,
    });
    // CaaS read position (add-caas-delivery-contract): pulling messages IS the
    // server-side fact that proves consumption. It advances for the SEAT, not
    // the message, and never regresses — see store.seatReadAdvance. Deliberately
    // here rather than in a render callback: "consumed" must not depend on a
    // page being live (web rooms have not been live since 11-17).
    if (auth.myUser?.id && messages.length > 0) {
      const maxSeq = messages[messages.length - 1].seq;
      try {
        store.seatReadAdvance(auth.room.id, auth.myUser.id, maxSeq);
      } catch {
        // A read-position write must never fail the read it accompanies.
      }
    }
    res.json({ messages });
  });

  // Polling transport for clients that cannot hold a long connection
  // (add-zhiyu-mobile-clients 1.2). Same cursor, same window reader, same
  // visibility as SSE — the difference is only how long a request lives.
  //
  // `wait` bounds the hold: with nothing new we hold up to N ms and return an
  // empty increment with the SAME cursor, so the client's loop is a plain
  // "ask again" and never has to invent a backoff schedule to stay correct.
  const STREAM_WAIT_DEFAULT_MS = 5_000;
  const STREAM_WAIT_MAX_MS = 25_000;

  /** Parse `?wait=`. Shared by the member and the guest polling lane. */
  const parseWait = (raw) => {
    const n = raw === undefined ? STREAM_WAIT_DEFAULT_MS : Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(Math.floor(n), STREAM_WAIT_MAX_MS);
  };

  /**
   * Hold an increment until something appears or the window closes.
   *
   * Polls INSIDE the hold rather than waiting for a bus signal: writers do not
   * all emit (a plain message append does not), and a transport that depends on
   * every writer remembering to notify is a transport with a silent hole in it.
   *
   * Shared by every polling transport — the guest lane below included — because
   * "how long we hold" and "what the cursor is" must have exactly one answer
   * (add-zhiyu-mobile-clients: 新传输与 SSE 同源).
   */
  const holdIncrement = async (read, wait) => {
    let rows = read();
    if (!rows.length && wait > 0) {
      const deadline = Date.now() + wait;
      while (!rows.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(200, Math.max(0, deadline - Date.now()))));
        rows = read();
      }
    }
    return rows;
  };

  app.get("/api/zhiyu/rooms/:id/stream", async (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const roomId = auth.room.id;
    const viewerMemberId = auth.myUser?.id ?? null;
    const after = Number(req.query.after ?? 0) || 0;
    const wait = parseWait(req.query.wait);
    if (wait === null) return res.status(400).json({ error: "wait must be a non-negative number of milliseconds" });

    const rows = await holdIncrement(() => readWindow({ roomId, viewerMemberId, after }), wait);
    // A row appended between the read and the response must not be lost: the
    // cursor is the last row we HAND BACK, never the one we asked after.
    const cursor = rows.length ? rows[rows.length - 1].seq : after;
    res.json({ messages: rows, cursor });
  });

  // SSE live stream (design D-E): seq-monotonic replay makes reconnect =
  // reread from `after` (or Last-Event-ID); no in-memory buffer to expire.
  app.get("/api/zhiyu/rooms/:id/events", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const roomId = auth.room.id;
    let last = Number(req.query.after ?? req.headers["last-event-id"] ?? 0) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`retry: 1000\n\n`);
    const pump = () => {
      try {
        const rows = readWindow({ roomId, viewerMemberId: auth.myUser?.id ?? null, after: last });
        for (const m of rows) {
          last = m.seq;
          res.write(`id: ${m.seq}\ndata: ${JSON.stringify(m)}\n\n`);
        }
      } catch (err) {
        console.error(`[zhiyu] SSE pump failed for ${roomId}:`, err.message);
      }
    };
    pump();
    const poll = setInterval(pump, ssePollMs);
    const keepalive = setInterval(() => res.write(`:ka\n\n`), 25_000);
    // Ephemeral overlay (live deltas / agent lifecycle): seq-less, never
    // persisted; private-window rows filtered per viewer like the DB pump.
    const onOverlay = (ev) => {
      try {
        if (ev.visibility && ev.visibility !== "shared" && ev.visibility !== `private:${auth.myUser?.id ?? ""}`) return;
        res.write(`event: overlay\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch { /* client gone */ }
    };
    bus.on(roomId, onOverlay);
    req.on("close", () => {
      clearInterval(poll);
      clearInterval(keepalive);
      bus.off(roomId, onOverlay);
    });
  });

  // ── Idle auto-close sweep ─────────────────────────────────────────────────

  const sweep = () => {
    try {
      for (const room of store.roomsIdleExpired(Date.now())) {
        store.roomSetStatus(room.id, "ended");
        emit(room.id, "system", "", { event: "room_ended", reason: "idle" });
        void endedHook(store.roomGet(room.id), "idle");
        console.log(`[zhiyu] room ${room.id} auto-closed (idle)`);
      }
    } catch (err) {
      console.error("[zhiyu] idle sweep failed:", err.message);
    }
  };
  const sweepTimer = startTimers ? setInterval(sweep, sweepMs) : null;
  sweepTimer?.unref?.();

  // ── Retention sweep (spec: 空间历史的有界保留) ────────────────────────────
  // Ended rooms' system/event rows age out; dialogue and private rows never do
  // (they need an explicit delete, not a timeout). Off via
  // ZHIYU_RETENTION_SWEEP=0; the day threshold is ZHIYU_RETENTION_DAYS (30).
  const retentionDays = clampInt(env.ZHIYU_RETENTION_DAYS, 30, 0, 3650);
  const retentionOn = String(env.ZHIYU_RETENTION_SWEEP ?? "1") !== "0" && retentionDays > 0;
  const retentionSweep = () => {
    if (!retentionOn) return;
    try {
      // Due-based, not boot-based: the marker lives in the room DB, so a pod
      // that lives 20 minutes still contributes a tick once the interval has
      // elapsed. (A "one hour after boot" timer never fires in production —
      // pods roll every 20–35 minutes and the timer restarts with them.)
      const out = store.retentionTick({ olderThanMs: retentionDays * 24 * 60 * 60 * 1000 });
      if (!out.ran) return;
      if (out.matched > 0) console.log(`[zhiyu] retention sweep matched=${out.matched} deleted=${out.deleted} (older than ${retentionDays}d)`);
      else console.log(`[zhiyu] retention sweep matched=0 deleted=0 (older than ${retentionDays}d)`);
    } catch (err) {
      console.error("[zhiyu] retention sweep failed:", err.message);
    }
  };
  // Every 10 minutes we ASK whether it is due; the sweep itself runs at most
  // once per 20h. Cheap (one row read when not due) and rollout-proof.
  const retentionTimer = startTimers && retentionOn ? setInterval(retentionSweep, 10 * 60 * 1000) : null;
  retentionTimer?.unref?.();
  if (startTimers && retentionOn) setTimeout(retentionSweep, 30 * 1000).unref?.();
  // One-shot proactive greeter timers live here so close() can cancel them
  // without dangling across a module reload.
  const proactiveTimers = new Set();

  // ── Widget embed: owner management (add-zhiyu-website-embed group 1/5) ─────

  const widgetRowFor = (roomId, kind = "embed") => store.widgetTokensForRoom(roomId).find((t) => !t.revokedAt && (kind ? t.kind === kind : true)) ?? null;
  const snippetFor = (token) => `<script src="${siteBase()}/zhiyu/widget.js" data-room="${token}" async></script>`;

  app.get("/api/zhiyu/rooms/:id/widget", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const row = widgetRowFor(auth.room.id);
    res.json({
      enabled: Boolean(row),
      publicOpen: widgetEnabled,
      token: row ? { fingerprint: row.fingerprint, allowlist: row.allowlist, createdAt: row.createdAt, revoked: Boolean(row.revokedAt) } : null,
      linkToken: (() => {
        const l = widgetRowFor(auth.room.id, "link");
        return l ? { fingerprint: l.fingerprint, createdAt: l.createdAt } : null;
      })(),
    });
  });

  app.post("/api/zhiyu/rooms/:id/widget", express.json({ limit: "8kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const allowlist = Array.isArray(req.body?.allowlist)
      ? req.body.allowlist.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 10)
      : [];
    if (!allowlist.length) return res.status(400).json({ error: "allowlist requires at least one domain" });
    const existing = widgetRowFor(auth.room.id);
    if (existing) {
      store.widgetTokenRevoke(existing.id);
    }
    const t = newWidgetToken();
    const sk = newSiteSecret();
    const row = store.widgetTokenCreate({
      rowId: t.id,
      roomId: auth.room.id,
      secHash: t.secHash,
      fingerprint: t.fingerprint,
      allowlist,
      siteSecretHash: sk.secretHash,
      kind: "embed",
    });
    res.json({
      token: t.token, // shown exactly once
      siteSecret: sk.secret, // shown exactly once
      fingerprint: row.fingerprint,
      snippet: snippetFor(t.token),
      embedUrl: `${siteBase()}/zhiyu/embed/${t.token}`,
    });
  });

  app.patch("/api/zhiyu/rooms/:id/widget", express.json({ limit: "8kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const row = widgetRowFor(auth.room.id);
    if (!row) return res.status(404).json({ error: "widget not enabled" });
    const allowlist = Array.isArray(req.body?.allowlist)
      ? req.body.allowlist.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 10)
      : null;
    if (allowlist && !allowlist.length) return res.status(400).json({ error: "allowlist may not be emptied while enabled" });
    const updated = allowlist ? store.widgetTokenSetAllowlist(row.id, allowlist) : row;
    res.json({ token: { fingerprint: updated.fingerprint, allowlist: updated.allowlist } });
  });

  app.post("/api/zhiyu/rooms/:id/widget/rotate-secret", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const row = widgetRowFor(auth.room.id);
    if (!row) return res.status(404).json({ error: "widget not enabled" });
    const sk = newSiteSecret();
    store.widgetTokenRotateSecret(row.id, sk.secretHash);
    res.json({ siteSecret: sk.secret, fingerprint: row.fingerprint });
  });

  app.post("/api/zhiyu/rooms/:id/widget/revoke", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    for (const t of store.widgetTokensForRoom(auth.room.id)) {
      if (!t.revokedAt) store.widgetTokenRevoke(t.id);
    }
    res.json({ ok: true });
  });

  // ── Team accounts (add-zhiyu-team-account): a TEAM's own outward address ──
  //
  // An account is created by a signed-in user for a fleet THEY own. The fleet
  // is verified against their own cell (sampleFleets) — not taken on trust —
  // and every later resolution re-asks the cell, so a fleet deleted in the
  // cell stops answering here without a mirrored copy going stale.

  const accountView = (account, tokens) => ({
    id: account.id,
    fleetId: account.fleetId,
    fleetName: account.fleetName,
    revoked: Boolean(account.revokedAt),
    idleMinutes: account.idleMinutes,
    replyCap: account.replyCap,
    createdAt: account.createdAt,
    doors: tokens.map((t) => ({
      id: t.id,
      fingerprint: t.fingerprint,
      kind: t.kind,
      allowlist: t.allowlist,
      revoked: Boolean(t.revokedAt),
      createdAt: t.createdAt,
    })),
  });

  app.get("/api/zhiyu/team-accounts", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    res.json({
      accounts: store.teamAccountsForOwner(user.email).map((a) => accountView(a, store.widgetTokensForAccount(a.id))),
    });
  });

  app.post("/api/zhiyu/team-accounts", express.json({ limit: "8kb" }), async (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const fleetId = String(req.body?.fleetId ?? "").trim();
    if (!fleetId) return res.status(400).json({ error: "fleetId is required" });
    // Ownership is a fact of the owner's cell, not of this request body.
    const fleets = sampleFleets ? await sampleFleets(user.email) : null;
    const fleet = (fleets?.fleets ?? []).find((f) => f.id === fleetId);
    if (!fleet) return res.status(404).json({ error: "not found" });
    const account = store.teamAccountCreate({
      fleetId,
      fleetName: fleet.name ?? "",
      ownerEmail: user.email,
      idleMinutes: clampInt(req.body?.idleMinutes, null, 0, IDLE_MINUTES_MAX),
      replyCap: clampInt(req.body?.replyCap, null, 1, 20),
    });
    res.status(201).json({ account: accountView(account, []) });
  });

  app.patch("/api/zhiyu/team-accounts/:accountId", express.json({ limit: "8kb" }), (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const account = store.teamAccountGet(req.params.accountId);
    // Someone else's account answers the same as a missing one.
    if (!account || account.ownerEmail !== user.email) return res.status(404).json({ error: "not found" });
    const patch = {};
    if (req.body?.idleMinutes !== undefined) patch.idleMinutes = clampInt(req.body.idleMinutes, account.idleMinutes, 0, IDLE_MINUTES_MAX);
    if (req.body?.replyCap !== undefined) patch.replyCap = clampInt(req.body.replyCap, account.replyCap, 1, 20);
    if (req.body?.fleetName !== undefined) patch.fleetName = String(req.body.fleetName).slice(0, 120);
    const updated = store.teamAccountPatch(account.id, patch);
    res.json({ account: accountView(updated, store.widgetTokensForAccount(updated.id)) });
  });

  app.post("/api/zhiyu/team-accounts/:accountId/revoke", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const account = store.teamAccountGet(req.params.accountId);
    if (!account || account.ownerEmail !== user.email) return res.status(404).json({ error: "not found" });
    // Revoking the account kills EVERY door at once (spec: 号吊销使全部挂载失效).
    const tokens = store.widgetTokensForAccount(account.id);
    for (const t of tokens) if (!t.revokedAt) store.widgetTokenRevoke(t.id);
    const revoked = store.teamAccountRevoke(account.id);
    res.json({ account: accountView(revoked, store.widgetTokensForAccount(revoked.id)) });
  });

  // Mint (or replace) the embed door for an account. Same token machinery as a
  // room's widget — only the target differs, so allowlists, revocation and the
  // snippet shape are identical by construction.
  app.post("/api/zhiyu/team-accounts/:accountId/widget", express.json({ limit: "8kb" }), (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const account = store.teamAccountGet(req.params.accountId);
    if (!account || account.ownerEmail !== user.email || account.revokedAt) return res.status(404).json({ error: "not found" });
    const allowlist = Array.isArray(req.body?.allowlist)
      ? req.body.allowlist.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 10)
      : [];
    if (!allowlist.length) return res.status(400).json({ error: "allowlist requires at least one domain" });
    for (const t of store.widgetTokensForAccount(account.id)) if (!t.revokedAt) store.widgetTokenRevoke(t.id);
    const t = newWidgetToken();
    const sk = newSiteSecret();
    const row = store.widgetTokenCreate({
      rowId: t.id,
      accountId: account.id,
      secHash: t.secHash,
      fingerprint: t.fingerprint,
      allowlist,
      siteSecretHash: sk.secretHash,
      kind: "embed",
    });
    res.json({
      token: t.token, // shown exactly once
      siteSecret: sk.secret, // shown exactly once
      fingerprint: row.fingerprint,
      snippet: snippetFor(t.token),
      embedUrl: `${siteBase()}/zhiyu/embed/${t.token}`,
    });
  });

  // Share-link weak lane (group 6): same token model, kind='link', no iframe.
  //
  // Minting REPLACES: a room holds at most one live link token, so asking for
  // another one kills the previous URL. That is deliberate (one link per room
  // keeps "which token is current" answerable), but it used to happen silently —
  // an operator who minted twice had no way to learn the URL they sent last week
  // was dead, and no way to find out it existed at all: the plaintext is never
  // stored, only sha256(sec). `replaced` is what makes the swap sayable.
  app.post("/api/zhiyu/rooms/:id/share-link", express.json({ limit: "4kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const existing = widgetRowFor(auth.room.id, "link");
    if (existing) store.widgetTokenRevoke(existing.id);
    const t = newWidgetToken();
    const sk = newSiteSecret();
    store.widgetTokenCreate({ rowId: t.id, roomId: auth.room.id, secHash: t.secHash, fingerprint: t.fingerprint, allowlist: [], siteSecretHash: sk.secretHash, kind: "link" });
    res.json({ url: `${siteBase()}/zhiyu/join/${t.token}`, token: t.token, fingerprint: t.fingerprint, replaced: Boolean(existing) });
  });

  app.post("/api/zhiyu/rooms/:id/share-link/revoke", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const row = widgetRowFor(auth.room.id, "link");
    if (row) store.widgetTokenRevoke(row.id);
    res.json({ ok: true });
  });

  // ── Mobile→web hand-off links (add-zhiyu-mobile-clients 5.1/5.2) ───────────
  //
  // Mint: any member can hand their OWN session over to the web to do the heavy
  // thing (a member manages their own private window and subscription; invites
  // and settings are owner-only, which the web surface re-checks — the link
  // grants nothing by itself, it only carries the user's intent to a browser
  // they are already signed into).
  //
  // Redeem: requires an authenticated user who is a member of that room. A
  // stolen token is therefore worth nothing to a stranger — the bearer still
  // has to hold a session with the room's authority.
  app.post("/api/zhiyu/rooms/:id/deeplink", express.json({ limit: "4kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const purpose = String(req.body?.purpose ?? "").trim();
    if (!isDeeplinkPurpose(purpose)) {
      return res.status(400).json({ error: "unknown purpose", purposes: [...DEEPLINK_PURPOSES] });
    }
    if (purpose !== "private_window" && purpose !== "subscription" && !auth.isOwner) {
      return res.status(403).json({ error: "room owner required" });
    }
    const minted = mintDeeplink(store, { roomId: auth.room.id, purpose, createdBy: auth.user.email });
    if (minted.error) return res.status(400).json({ error: minted.error });
    res.json({
      url: `${siteBase()}/zhiyu/deeplink/${minted.token}`,
      path: `/zhiyu/deeplink/${minted.token}`,
      purpose: minted.purpose,
      expiresAt: minted.expiresAt,
    });
  });

  // Spend it. One-time: the second POST with the same token is 404.
  app.post("/api/zhiyu/deeplink/:token", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const peek = verifyDeeplink(store, req.params.token);
    if (!peek) return res.status(404).json({ error: "not found" });
    const auth = authorize(req, res, peek.roomId);
    if (!auth) return;
    const done = redeemDeeplink(store, req.params.token, { usedBy: user.email });
    if (!done) return res.status(404).json({ error: "not found" });
    res.json({ roomId: done.roomId, purpose: done.purpose, path: done.path });
  });

  // The shell the link opens. A GET must NOT spend the link — a link preview
  // crawler (WeChat unfurls every URL pasted into a chat) would eat it before
  // the user ever tapped. Only the SPA's POST spends.
  app.get("/zhiyu/deeplink/:token", (req, res) => {
    if (!verifyDeeplink(store, req.params.token) || !webDist) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const dlHtml = guestShellHtml();
    if (dlHtml === null) return res.status(502).end("page unavailable");
    res.end(dlHtml);
  });

  // ── Widget public lanes ────────────────────────────────────────────────────

  // Guest lanes must not ship the 萬星 cross-line copilot. It is mounted from a
  // static <script> in web/index.html, and every guest page is the SAME
  // index.html delivered through an SPA route — so a visitor (no 壹座 account,
  // no business seeing a product-line entry) got a floating 「壹座」 button on a
  // link they were handed. The loader reads no route state, so the gate belongs
  // here, at the one place that knows "this HTML is a visitor shell".
  const guestShellHtml = () => {
    try {
      return readFileSync(path.join(webDist, "index.html"), "utf8").replace(
        /\s*<script[^>]*wanxing\.finddatatech\.cloud\/copilot\.js[^>]*>\s*<\/script>/g,
        "",
      );
    } catch {
      return null;
    }
  };

  // Loader meta: the script's allowlist double-check + room banner data +
  // the callable seat lineup (displays power the visitor's @ completion).
  app.get("/zhiyu/widget/meta", (req, res) => {
    const token = String(req.query.token ?? "");
    const row = widgetEnabled ? verifyWidgetToken(store, token) : null;
    if (!row) return res.status(404).json({ error: "not found" });
    // Link tokens (join links) are OPENED, never embedded — the host gate is
    // an embed-lane rule only, matching authorizeWidget's kind check.
    if (row.kind !== "link" && !hostAllowed(row.allowlist, String(req.query.host ?? ""))) {
      return res.status(403).json({ error: "host not allowed" });
    }
    // Account tokens carry no room of their own; the meta call is read-only
    // about the OWNER's lineup, so it resolves an existing room when there is
    // one and never opens a room (a loader preflight must not spawn rooms).
    const account = row.accountId ? store.teamAccountGet(row.accountId) : null;
    if (row.accountId && (!account || account.revokedAt)) return res.status(404).json({ error: "not found" });
    const roomId = account
      ? store.accountRoomForVisitor(account.id, guestRefFromRequest(req)) ?? null
      : row.roomId;
    const room = roomId ? store.roomGet(roomId) : null;
    const host = (account?.ownerEmail ?? room?.ownerEmail ?? "").split("@")[1] ?? "host";
    const agents = room
      ? store
          .membersOf(room.id)
          .filter((m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active")
          .map((m) => ({ kind: m.kind, display: m.display || m.ref }))
      : [];
    res.json({ title: room?.title ?? (account?.fleetName ? `${account.fleetName} · 接待` : ""), host, agents, banner: `你是访客身份，由 ${account?.ownerEmail ?? room?.ownerEmail ?? host} 的值守分身接待` });
  });

  // The loader itself: static ESM string (no env interpolation), serves one
  // preflight meta call and mounts the iframe on allowlist hit.
  const WIDGET_JS = `(() => {
  const me = document.currentScript;
  const token = me.getAttribute("data-room") || "";
  const origin = new URL(me.src).origin;
  const host = location.host;
  fetch(origin + "/zhiyu/widget/meta?token=" + encodeURIComponent(token) + "&host=" + encodeURIComponent(host))
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((meta) => {
      const root = document.createElement("div");
      root.id = "zhiyu-widget-root";
      root.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;width:min(380px,92vw);height:min(560px,80vh);box-shadow:0 8px 30px rgba(0,0,0,.18);border-radius:12px;overflow:hidden;background:#fff;display:flex;flex-direction:column";
      const bar = document.createElement("div");
      bar.style.cssText = "padding:6px 10px;font:12px system-ui;background:#111827;color:#fff;cursor:pointer;user-select:none";
      bar.textContent = "会话 · " + meta.title;
      const iframe = document.createElement("iframe");
      iframe.src = origin + "/zhiyu/embed/" + encodeURIComponent(token) + "?host=" + encodeURIComponent(host);
      iframe.style.cssText = "border:0;flex:1;width:100%";
      iframe.allow = "clipboard-write";
      let openFlag = true;
      const setOpen = (v) => { openFlag = v; iframe.style.display = v ? "" : "none"; };
      bar.onclick = () => setOpen(!openFlag);
      root.appendChild(bar);
      root.appendChild(iframe);
      document.body.appendChild(root);
      window.addEventListener("message", (ev) => {
        if (ev.origin !== origin) return;
        const d = ev.data || {};
        if (d.type === "zhiyu:ready") iframe.contentWindow.postMessage({ type: "zhiyu:init" }, origin);
      });
    })
    .catch(() => { /* silently inert off-allowlist */ });
})();
`;

  app.get("/zhiyu/widget.js", (_req, res) => {
    if (!widgetEnabled) return res.status(404).end();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.end(WIDGET_JS);
  });

  // The embed shell: dynamic frame-ancestors per token's allowlist, else 404.
  app.get("/zhiyu/embed/:token", (req, res) => {
    const row = widgetEnabled ? verifyWidgetToken(store, req.params.token) : null;
    if (!row) return res.status(404).json({ error: "not found" });
    // Account tokens name a TEAM, not a room — the shell itself carries no room
    // state (it is a page skeleton; the visitor's room is resolved by /visit),
    // so only the account's liveness matters here. Legacy room tokens keep
    // their original check.
    if (row.accountId) {
      const account = store.teamAccountGet(row.accountId);
      if (!account || account.revokedAt || !webDist) return res.status(404).json({ error: "not found" });
    } else {
      const room = store.roomGet(row.roomId);
      if (!room || !webDist) return res.status(404).json({ error: "not found" });
    }
    // frame-ancestors is https-only (polish-zhiyu-embed-csp-and-site-seats O1):
    // the embed shell is the visitor entrance, and its parent page must be
    // loaded over https — an http site gets the same treatment as a
    // non-allowlisted one (the browser refuses to render). No http:// sibling
    // source is minted for allowlisted hosts anymore.
    const allow = ["'self'", ...row.allowlist.flatMap((h) => (h.startsWith("*.") ? [`https://${h}`, `https://*.${h.slice(2)}`] : [`https://${h}`]))];
    res.setHeader("Content-Security-Policy", `frame-ancestors ${allow.join(" ")}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const embHtml = guestShellHtml();
    if (embHtml === null) return res.status(502).end("widget shell unavailable");
    res.end(embHtml);
  });

  // A dead join link, in words.
  //
  // Three causes — the token never existed, it was revoked (minting a new link
  // replaces the old one as of harden-zhiyu-outbound-lanes), or it names an
  // embed token instead of a link token — all answer the SAME bytes, so the
  // page can never be used to probe whether a given token once existed. It is
  // hand-served rather than SPA-routed because the SPA has no notion of "this
  // token is invalid": shipping the bad token into it only moves the confusion
  // one layer down. It also must not depend on web/dist — a live join link and
  // a dead one differ by a token, not by whether this deployment ships a web
  // bundle.
  const deadJoinHtml = () => {
    const title = "进房链接已失效";
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         background:#fafafa; color:#1a1a1a; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#141414; color:#e8e8e8; } }
  main { max-width: 26rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .6rem; }
  p { margin: 0 0 .5rem; color:#666; }
  @media (prefers-color-scheme: dark) { p { color:#9a9a9a; } }
</style></head>
<body><main>
  <h1>${title}</h1>
  <p>这条进房链接已失效或被收回。</p>
  <p>请向邀请你的人索取一条新的链接。</p>
</main></body></html>`;
  };

  // Join-link shell (group 6): top-level full page; same token lane, no
  // frame-ancestors requirement (these links are opened, never embedded).
  app.get("/zhiyu/join/:token", (req, res) => {
    const row = widgetEnabled ? verifyWidgetToken(store, req.params.token) : null;
    if (!row || row.kind !== "link") {
      res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(404).end(deadJoinHtml());
    }
    if (row.accountId) {
      const account = store.teamAccountGet(row.accountId);
      if (!account || account.revokedAt) {
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(404).end(deadJoinHtml());
      }
    } else {
      const room = store.roomGet(row.roomId);
      if (!room) {
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(404).end(deadJoinHtml());
      }
    }
    if (!webDist) return res.status(502).end("page unavailable");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const joinHtml = guestShellHtml();
    if (joinHtml === null) return res.status(502).end("page unavailable");
    res.end(joinHtml);
  });

  // visit: mint/reuse a guest seat on this room's token.
  app.post("/zhiyu/widget/:token/visit", express.json({ limit: "8kb" }), async (req, res) => {
    const ctx = await authorizeWidget(req, res);
    if (!ctx) return;
    const { room } = ctx;
    if (!takeToken(`visit:${req.ip}`, 20, 60_000)) return res.status(429).json({ error: "rate limited" });
    let seat = guestSeat(req, room.id);
    let ttyOut = null;
    if (!seat) {
      const ref = guestRefFor();
      const member = store.memberAdd({ roomId: room.id, kind: "guest", ref, display: `访客 · ${(cookieHost(req) ?? "guest").split(":")[0]}`, historyGrant: "join_from", invitedBy: "widget" });
      emit(room.id, "system", "", { event: "guest_joined", member: { id: member.id, display: member.display } });
      // AI-free greeting (polish batch): first contact names the callable seats
      // — the visitor learns `@` exists without burning a model turn. Every
      // active seat is named (polish-zhiyu-reception-welcome-line): a hard cap
      // of 3 left the fourth agent callable-but-unadvertised, so pointing at it
      // never happened. Only a very large roster is abbreviated, and then the
      // line says so.
      const activeSeats = store
        .membersOf(room.id)
        .filter((m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active")
        .map((m) => m.display || m.ref);
      const GREETING_SEAT_CAP = 6;
      const agents = activeSeats.slice(0, GREETING_SEAT_CAP);
      if (agents.length) {
        const more = activeSeats.length > GREETING_SEAT_CAP ? ` 等 ${activeSeats.length} 席` : "";
        store.messageAppend({
          roomId: room.id,
          kind: "system",
          content: `欢迎——我是值班席位。你可以直接说事，或点名：${agents.map((n) => `@${n}`).join(" ")}${more}。`,
          meta: { event: "guest_greeting", agents, seats: activeSeats.length },
        });
      }
      // Proactive greeting (opt-in per room): if nobody has spoken after a
      // deliberate beat, a duty seat introduces itself. The visitor shouldn't
      // have to break the ice alone; skipping is automatic if someone has.
      if (Array.isArray(agents) && agents.length && room.proactiveGreeting) {
        const pending = setTimeout(() => {
          proactiveTimers.delete(pending);
          try {
            const fresh = store.roomGet(room.id);
            if (!fresh || fresh.status !== "active") return;
            // The "has anyone spoken since this visitor joined?" test must read
            // the TAIL, not seq 0: a room with more than one window of history
            // would find the join event inside the first page and conclude that
            // guests have already been answered (polish-zhiyu-reception-welcome-line).
            const laterRows = store.messagesTail(room.id, 200, { viewerMemberId: null });
            const guestSeq = laterRows.findLast?.((m) => m.meta?.event === "guest_joined")?.seq ?? null;
            const since = guestSeq == null ? [] : laterRows.filter((m) => m.seq > guestSeq && (m.kind === "human" || m.kind === "agent"));
            if (since.length) return;
            const duty = store
              .membersOf(room.id)
              .find((m) => (m.kind === "facade" || m.kind === "agent") && m.state === "active");
            if (!duty) return;
            void Promise.resolve(
              router.directiveTurn({
                room: fresh,
                targetRef: duty.ref,
                directive: `一位访客刚进来,暂时还没有人说话。请你以自己的身份,用一两句温暖简洁的话欢迎他/她,并说出你能帮上什么(不要追问他答复,不要说教或念规则)。`,
              }),
            ).catch((err) => console.error(`[zhiyu] proactive greeting failed for ${room.id}:`, err.message));
          } catch (err) {
            console.error("[zhiyu] proactive greeting timer failed:", err.message);
          }
        }, proactiveDelayMs);
        proactiveTimers.add(pending);
      }
      seat = { member };
      const issued = serveGuestPass(room.id, ref);
      res.setHeader("Set-Cookie", issued.setCookie);
      ttyOut = issued.tty;
    }
    // A REUSED seat (cookie hit) must still hand back a usable pass. The mint
    // branch above only sets ttyOut; a returning visitor in a fresh tab has the
    // cookie but no sessionStorage tty, got `tty: null`, and the composer
    // renders `disabled` — "点发送没反应" was exactly this.
    res.json({ ok: true, ref: seat.member.ref, display: seat.member.display, memberId: seat.member.id, tty: ttyOut ?? seat.tty ?? req.query.tty ?? null, roomId: room.id, title: room.title });
  });

  // Widget message enrichment: rows carry enough attribution for the visitor
  // page to say WHO answered (display + 代 X 出席), not a muted "接待" blob.
  const widgetSenderOf = (roomId) => {
    const members = new Map(store.membersOf(roomId).map((m) => [m.id, m]));
    return (m) => {
      const sender = m.senderMemberId ? members.get(m.senderMemberId) : null;
      return {
        ...m,
        sender: sender
          ? { kind: sender.kind, display: sender.display || sender.ref, onBehalfOf: sender.onBehalfOf ?? null }
          : null,
      };
    };
  };

  app.get("/api/zhiyu/widget/:token/messages", async (req, res) => {
    const ctx = await authorizeWidget(req, res, { requireHost: false, openRoom: false });
    if (!ctx) return;
    const seat = guestSeat(req, ctx.room.id);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    const has = (k) => req.query[k] !== undefined && req.query[k] !== "";
    if ((has("after") && has("before")) || (has("after") && has("tail")) || (has("before") && has("tail"))) {
      return res.status(400).json({ error: "after, before and tail are mutually exclusive" });
    }
    const rawLimit = has("limit") ? Number(req.query.limit) : 200;
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) return res.status(400).json({ error: "limit must be a positive number" });
    const limit = Math.min(Math.floor(rawLimit), 500);
    const viewerMemberId = seat.member.id;
    const enrich = widgetSenderOf(ctx.room.id);
    // Same window contract as the in-room route, through the SAME reader: bare
    // = after 0 (compat), ?tail=N = first-screen window, ?before=N = earlier.
    const raw = readWindow({
      roomId: ctx.room.id,
      viewerMemberId,
      ...(has("tail") ? { tail: req.query.tail } : {}),
      ...(has("before") ? { before: req.query.before } : {}),
      ...(has("after") ? { after: req.query.after } : {}),
      limit,
    });
    const messages = raw
      .filter((m) => m.visibility === "shared" || m.visibility === `private:${viewerMemberId}`)
      .map(enrich);
    res.json({ messages });
  });

  // Polling increment for a guest on a phone (add-zhiyu-mobile-clients 6.3): a
  // visitor is a first-class reader on the mobile clients, and a guest on a
  // phone cannot hold SSE any more than a member can. Same reader, same cursor
  // rule, same hold — only the seat is different, and the seat is the ONLY
  // difference: no guest-only capability is added here.
  app.get("/api/zhiyu/widget/:token/stream", async (req, res) => {
    const ctx = await authorizeWidget(req, res, { requireHost: false, openRoom: false });
    if (!ctx) return;
    const seat = guestSeat(req, ctx.room.id);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    const roomId = ctx.room.id;
    const viewerMemberId = seat.member.id;
    const after = Number(req.query.after ?? 0) || 0;
    const wait = parseWait(req.query.wait);
    if (wait === null) return res.status(400).json({ error: "wait must be a non-negative number of milliseconds" });
    const rows = await holdIncrement(() => readWindow({ roomId, viewerMemberId, after }), wait);
    const enrich = widgetSenderOf(roomId);
    const messages = rows
      .filter((m) => m.visibility === "shared" || m.visibility === `private:${viewerMemberId}`)
      .map(enrich);
    const cursor = rows.length ? rows[rows.length - 1].seq : after;
    res.json({ messages, cursor });
  });

  app.post("/api/zhiyu/widget/:token/messages", express.json({ limit: "16kb" }), async (req, res) => {
    const ctx = await authorizeWidget(req, res);
    if (!ctx) return;
    const { room } = ctx;
    if (room.status !== "active") return res.status(409).json({ error: "room ended" });
    const seat = guestSeat(req, room.id);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    if (!takeToken(`msg:${seat.member.id}`, 8, 60_000)) return res.status(429).json({ error: "rate limited, slow down" });
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content required" });
    if (content.length > 16_000) return res.status(400).json({ error: "content too long" });
    const { row: appended } = store.messageAppend({ roomId: room.id, kind: "human", senderMemberId: seat.member.id, content });
    void Promise.resolve(humanMessageHook({ room, member: seat.member, message: appended })).catch((err) =>
      console.error(`[zhiyu] widget round router failed for ${room.id}:`, err),
    );
    res.json({ message: appended });
  });

  app.get("/api/zhiyu/widget/:token/events", async (req, res) => {
    const ctx = await authorizeWidget(req, res, { requireHost: false, openRoom: false });
    if (!ctx) return;
    const seat = guestSeat(req, ctx.room.id);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    const roomId = ctx.room.id;
    let last = Number(req.query.after ?? req.headers["last-event-id"] ?? 0) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`retry: 1000\n\n`);
    const pump = () => {
      try {
        const enrich = widgetSenderOf(roomId);
        for (const m of store.messagesAfter(roomId, last, { viewerMemberId: seat.member.id })) {
          last = m.seq;
          res.write(`id: ${m.seq}\ndata: ${JSON.stringify(enrich(m))}\n\n`);
        }
      } catch (err) {
        console.error(`[zhiyu] widget SSE pump failed for ${roomId}:`, err.message);
      }
    };
    pump();
    const poll = setInterval(pump, ssePollMs);
    // Ephemeral overlay (answering bubble + deltas) — guests get the same
    // honesty overlay station users have, or a 70s cold start reads as dead air.
    const onOverlay = (ev) => {
      try {
        if (ev.visibility && ev.visibility !== "shared") return;
        res.write(`event: overlay\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch { /* client gone */ }
    };
    bus.on(roomId, onOverlay);
    const keepalive = setInterval(() => res.write(`:ka\n\n`), 25_000);
    req.on("close", () => {
      clearInterval(poll);
      clearInterval(keepalive);
      bus.off(roomId, onOverlay);
    });
  });

  app.post("/api/zhiyu/widget/:token/identify", express.json({ limit: "8kb" }), async (req, res) => {
    const ctx = await authorizeWidget(req, res);
    if (!ctx) return;
    const { row, room } = ctx;
    const seat = guestSeat(req, room.id);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const displayName = String(req.body?.displayName ?? email).slice(0, 80);
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).json({ error: "email required" });
    if (!verifyIdentify(store, row, { presentedSecret: req.body?.secret, ts: req.body?.ts, nonce: req.body?.nonce })) {
      return res.status(403).json({ error: "identify refused" });
    }
    // Merge: the guest member row becomes the user row (same id → message
    // attribution history carries over byte-for-byte).
    const member = store.memberUpgradeToUser(seat.member.id, { email, display: displayName });
    emit(room.id, "system", "", { event: "guest_identified", member: { id: member.id, display: member.display } });
    res.setHeader("Set-Cookie", `zy_guest=; Path=/; Max-Age=0; SameSite=None; Secure; HttpOnly`);
    res.json({ ok: true, member });
  });

  // ── Room attachments (zhiyu-room-attachments) ──────────────────────────────
  // Bytes belong to the ROOM (see attachments.js). The attachment rides a
  // normal human message row — no new row kind, so cursors, visibility, the
  // round router and reasing all keep their existing meaning.
  //
  // Read authority is the ROW's visibility, and it is enforced by resolving the
  // row the same way the message windows do: never by trusting the attachment
  // id alone.
  const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

  // multer's size ceiling must answer 413, not surface as a 500. Both upload
  // doors need this: an oversized file is a REFUSAL, and the client's copy
  // depends on being able to tell it apart from a server fault.
  const uploadSizeGate = (mw) => (req, res, next) =>
    mw(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "文件超过上传上限", code: "file_too_large" });
      }
      return res.status(400).json({ error: "invalid multipart upload", code: "bad_upload" });
    });


  const rowVisibleTo = ({ roomId, rowSeq, viewerMemberId }) => {
    const row = store.messageAt(roomId, rowSeq);
    if (!row) return null;
    if (row.visibility === "shared") return row;
    if (viewerMemberId && row.visibility === `private:${viewerMemberId}`) return row;
    return null;
  };

  const contentDisposition = (att) => {
    // inline only for types the browser cannot execute against our origin;
    // everything else is a forced download with an opaque type — the same
    // posture as server/routes/files.js.
    const name = String(att.name || "file").replace(/["\\\r\n]/g, "_");
    const safe = /^(image\/(png|jpeg|gif|webp|bmp|avif)|application\/pdf|text\/plain|audio\/|video\/)/i.test(att.mime || "");
    return safe
      ? { type: att.mime || "application/octet-stream", disposition: `inline; filename*=UTF-8''${encodeURIComponent(name)}` }
      : { type: "application/octet-stream", disposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}` };
  };

  // Shared body of both upload doors: quota → bytes → row → attachment → settle.
  async function acceptUpload({ req, res, room, ownerMemberId, sourceKind }) {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "file required", code: "file_required" });
    const guest = sourceKind === "guest";
    const audio = isAudio(file.originalname, file.mimetype);
    const max = guest ? attachments.limits.guestFileBytes : audio ? attachments.limits.audioMaxBytes : attachments.limits.docMaxBytes;
    if (file.size > max) {
      // An oversized RECORDING gets a pointer to the lane that CAN take it:
      // the capture lane slices and transcribes long audio, this one door does
      // not. A bare "too large" would leave the user with nowhere to go.
      return res.status(413).json({
        error: audio
          ? `录音超过 ${Math.round(max / 1024 / 1024)} MB 上限；长录音请用会话记忆页的「记录一段会议」分段转写`
          : `文件超过 ${Math.round(max / 1024 / 1024)} MB 上限`,
        code: "file_too_large",
        limit: max,
        ...(audio ? { hint: "voice_capture_lane" } : {}),
      });
    }
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const dailyCap = guest ? attachments.limits.guestDailyBytes : attachments.limits.memberDailyBytes;
    if (ownerMemberId && store.attachmentOwnerBytesToday(room.id, ownerMemberId, since) + file.size > dailyCap) {
      return res.status(413).json({ error: "今日上传总量已达上限", code: "daily_quota_exceeded", limit: dailyCap });
    }
    if (store.attachmentRoomBytes(room.id) + file.size > attachments.limits.roomMaxBytes) {
      return res.status(413).json({ error: "房间附件总量已达上限", code: "room_quota_exceeded", limit: attachments.limits.roomMaxBytes });
    }
    const content = String(req.body?.content ?? "").trim() || `发了 ${String(file.originalname ?? "文件").slice(0, 120)}`;
    const { row } = store.messageAppend({ roomId: room.id, kind: "human", senderMemberId: ownerMemberId, content });
    const { attachment, buffer } = await attachments.accept({
      roomId: room.id,
      rowSeq: row.seq,
      ownerMemberId,
      sourceKind,
      name: file.originalname,
      mime: file.mimetype,
      buffer: file.buffer,
    });
    // Reflect the reference on the row it rides, so every reader (prompt
    // assembler, card model, retention) finds it the same way.
    store.messagePatchMeta(room.id, row.seq, { attachment: { id: attachment.id, name: attachment.name, mime: attachment.mime, bytes: attachment.bytes, status: attachment.status } });
    // Text files settle through the bounded queue; the response carries the
    // state the client will see when it re-reads (queued extraction is fast,
    // but the queue must not hold the event loop — design D12).
    let settled = attachment;
    if (audio) {
      attachments.enqueue(() => attachments.settleAudio(attachment, buffer));
    } else if (canExtract(file.originalname)) {
      settled = await attachments.settleText(attachment, buffer, { name: file.originalname });
    }
    return res.status(201).json({ message: store.messageAt(room.id, row.seq), attachment: settled });
  }

  app.post("/api/zhiyu/rooms/:id/attachments", uploadSizeGate(attachmentUpload.single("file")), async (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    if (!auth.myUser) return res.status(403).json({ error: "active user seat required" });
    applyTakeOver(auth);
    try {
      await acceptUpload({ req, res, room: auth.room, ownerMemberId: auth.myUser.id, sourceKind: "member" });
    } catch (err) {
      console.error(`[zhiyu-attach] member upload failed: ${err?.message || err}`);
      if (!res.headersSent) res.status(500).json({ error: "附件保存失败", code: "attachment_store_failed" });
    }
  });

  app.get("/api/zhiyu/rooms/:id/attachments/:aid/content", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const att = store.attachmentGet(req.params.aid);
    if (!att || att.roomId !== auth.room.id) return res.status(404).json({ error: "not found" });
    const row = rowVisibleTo({ roomId: auth.room.id, rowSeq: att.rowSeq, viewerMemberId: auth.myUser?.id ?? null });
    if (!row) return res.status(404).json({ error: "not found" });
    if (att.purged) return res.status(410).json({ error: "附件已过期", code: "attachment_expired" });
    attachments.readBytes(att).then((bytes) => {
      if (!bytes) return res.status(404).json({ error: "not found" });
      const { type, disposition } = contentDisposition(att);
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Disposition", disposition);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(bytes);
    });
  });

  // Guest upload door (zhiyu-widget): same bytes, own quota, own rate bucket.
  app.post("/api/zhiyu/widget/:token/attachments", uploadSizeGate(attachmentUpload.single("file")), async (req, res) => {
    const ctx = await authorizeWidget(req, res);
    if (!ctx) return;
    const { room } = ctx;
    if (room.status !== "active") return res.status(409).json({ error: "room ended" });
    const seat = guestSeat(req, room.id);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    if (!takeToken(`att:${seat.member.id}`, 6, 60_000)) return res.status(429).json({ error: "rate limited, slow down" });
    try {
      await acceptUpload({ req, res, room, ownerMemberId: seat.member.id, sourceKind: "guest" });
    } catch (err) {
      console.error(`[zhiyu-attach] guest upload failed: ${err?.message || err}`);
      if (!res.headersSent) res.status(500).json({ error: "附件保存失败", code: "attachment_store_failed" });
    }
  });

  // Guest transcription door (voice-lane's new requirement): same protocol,
  // deployment credential, guest seat's own throttle. Nothing is stored.
  const guestAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: voiceUploadMaxBytes() } });
  function voiceUploadMaxBytes() {
    const n = Number(env.ZHIYU_VOICE_MAX_BYTES);
    return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
  }
  app.post("/api/zhiyu/widget/:token/transcriptions", uploadSizeGate(guestAudio.single("file")), async (req, res) => {
    const ctx = await authorizeWidget(req, res);
    if (!ctx) return;
    const { room } = ctx;
    const seat = guestSeat(req, room.id);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    if (!takeToken(`asr:${seat.member.id}`, 6, 60_000)) return res.status(429).json({ error: "rate limited, slow down" });
    if (!req.file) return res.status(400).json({ error: "file required", code: "file_required" });
    const out = await voiceForward.transcribe({ buffer: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname });
    if (!out.ok) return res.status(out.status).json(out.body);
    res.json({ text: out.text });
  });

  // "Can this room accept an attachment / a transcript right now?" — the four
  // clients render entries from this instead of guessing from build flags.
  app.get("/api/zhiyu/rooms/:id/attachments/status", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    res.json({
      enabled: true,
      voice: voiceForward.available(),
      limits: {
        file: attachments.limits.docMaxBytes,
        audio: attachments.limits.audioMaxBytes,
        roomBytes: attachments.limits.roomMaxBytes,
        roomBytesUsed: store.attachmentRoomBytes(auth.room.id),
      },
    });
  });

  // ── IM bridge machine lanes (add-zhiyu-im-bridge) ──────────────────────────
  // The cell-side bridge calls these with the gateway secret: ingest of IM
  // group messages as room guest rows, and a bot-scoped read-only event
  // subscription face back to the cell. Registered before the 404 catch-all.
  registerZhiyuImBridge(app, {
    store,
    humanMessageHook,
    secret: guestSecret || secret,
    // A team account opens a room on demand; that room must arrive with the
    // team's seats in it or it is an address nobody answers at.
    seeder: accountRoomSeeder,
  });

  // ── Room speech (add-room-voice-and-catalog) ──────────────────────────────
  // A seat's message spoken aloud, on demand or queued behind "voice on". The
  // credential is the DEPLOYMENT's (a room has no member cell and a guest has
  // none at all); voice resolution is seat → post → deployment, and a stale
  // catalog entry is skipped rather than failing.
  const roomSpeech = createRoomSpeech({ store, voiceForward, dataRoot, env });
  registerZhiyuRoomSpeech(app, { store, authorize, speech: roomSpeech, express });

  // ── Capture ingest (add-speaker-attribution D9's transport) ───────────────
  // A finished meeting recording's per-speaker messages carry their own
  // evidence; this face puts them in the room so the existing voiceRoute seam
  // can route them. Capture-only by construction (a message without evidence is
  // refused), so it cannot become a general "post as anyone" door.
  registerZhiyuCaptureIngest(app, { store, humanMessageHook, secret: guestSecret || secret });

  // The prefix is owned: unmatched /api/zhiyu/* paths must 404 here (JSON),
  // never proxy into a cell where a same-named route could answer with a
  // different meaning. Register it AFTER every zhiyu route is mounted.
  const registerNotFound = () => {
    app.all(/^\/api\/zhiyu(\/.*)?$/, (_req, res) => {
      res.status(404).json({ error: "not found" });
    });
  };
  if (!deferNotFound) registerNotFound();

  return {
    store,
    registerNotFound,
    replyCap,
    effectiveCap,
    router,
    bus,
    // One-shot proactive greeter timers (visits opt-in per room); cleared at
    // shutdown so a roll never fires a turn into thin air.
    proactiveTimers,
    sweep,
    close() {
      if (sweepTimer) clearInterval(sweepTimer);
      for (const t of proactiveTimers) clearTimeout(t);
      proactiveTimers.clear();
      bus.removeAllListeners();
      if (!storeOpt) store.close();
    },
  };
}
