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
import { createZhiyuStore } from "./store.js";
import { createRoomRouter } from "./room-router.js";
import { chatMemoryBlockFor } from "@finddatatechnology/yongyi-client";
import { newWidgetToken, newSiteSecret, verifyWidgetToken, hostAllowed, signGuestPass, verifyGuestPass, verifyIdentify, guestRefFor } from "./guest-auth.js";
import { mintDeeplink, redeemDeeplink, verifyDeeplink, isDeeplinkPurpose, DEEPLINK_PURPOSES } from "./deeplink.js";
import { registerZhiyuImBridge } from "./im-bridge.js";

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
  const wiredMemoryBlock =
    memoryBlock ??
    (async ({ sender, query }) => {
      if (!sender || sender.kind !== "user" || !sender.ref) return "";
      const { block } = await chatMemoryBlockFor(sender.ref, query, env);
      return block;
    });
  const router = createRoomRouter({
    store,
    effectiveCap,
    callAgent: callAgent ?? missingLane,
    settleTurn,
    memoryBlock: wiredMemoryBlock,
    voiceRoute,
    onBudgetWarning: (room, dayTurns, budget) =>
      notifyUser("budget_warning", {
        to: room.ownerEmail,
        roomId: room.id,
        roomTitle: room.title,
        dayTurns,
        budget,
      }),
    bus,
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
  function authorizeWidget(req, res, { requireHost = true } = {}) {
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
    const room = store.roomGet(row.roomId);
    if (!room) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return { row, room };
  }

  // Guest seat by pass (cookie first, tty fallback): returns { member, tty }.
  // Member presence is derived from the pass signature — the pass names the
  // seat ref, we look it up; a stale or absent pass mints a NEW seat at visit
  // time (never silently merges two visitors).
  function guestSeat(req, row) {
    const cookie = (req.headers.cookie || "");
    const m = /(?:^|;\s*)zy_guest=([^;]+)/.exec(cookie);
    const presented = (m ? decodeURIComponent(m[1]) : null) ?? req.query.tty ?? req.body?.tty ?? null;
    const pass = presented && guestSecret ? verifyGuestPass(guestSecret, presented) : null;
    if (pass && pass.roomId === row.roomId) {
      const member = store.memberFor(row.roomId, "guest", pass.ref);
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
    });
    if (member.state !== "active") store.memberSetState(member.id, "active");
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
    const idleMinutes = req.body?.idleMinutes === undefined ? 15 : clampInt(req.body.idleMinutes, 15, 1, 1440);
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
    if (req.body?.idleMinutes !== undefined) {
      const n = Number(req.body.idleMinutes);
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        return res.status(400).json({ error: "idleMinutes must be an integer within 1..1440" });
      }
      patch.idleMinutes = n;
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

  // Share-link weak lane (group 6): same token model, kind='link', no iframe.
  app.post("/api/zhiyu/rooms/:id/share-link", express.json({ limit: "4kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const existing = widgetRowFor(auth.room.id, "link");
    if (existing) store.widgetTokenRevoke(existing.id);
    const t = newWidgetToken();
    const sk = newSiteSecret();
    store.widgetTokenCreate({ rowId: t.id, roomId: auth.room.id, secHash: t.secHash, fingerprint: t.fingerprint, allowlist: [], siteSecretHash: sk.secretHash, kind: "link" });
    res.json({ url: `${siteBase()}/zhiyu/join/${t.token}`, token: t.token, fingerprint: t.fingerprint });
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
    try {
      res.end(readFileSync(path.join(webDist, "index.html"), "utf8"));
    } catch {
      res.status(502).end("page unavailable");
    }
  });

  // ── Widget public lanes ────────────────────────────────────────────────────

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
    const room = store.roomGet(row.roomId);
    const host = (room?.ownerEmail ?? "").split("@")[1] ?? "host";
    const agents = room
      ? store
          .membersOf(room.id)
          .filter((m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active")
          .map((m) => ({ kind: m.kind, display: m.display || m.ref }))
      : [];
    res.json({ title: room?.title ?? "", host, agents, banner: `你是访客身份，由 ${room?.ownerEmail ?? host} 的值守分身接待` });
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
    const room = store.roomGet(row.roomId);
    if (!room || !webDist) return res.status(404).json({ error: "not found" });
    // frame-ancestors is https-only (polish-zhiyu-embed-csp-and-site-seats O1):
    // the embed shell is the visitor entrance, and its parent page must be
    // loaded over https — an http site gets the same treatment as a
    // non-allowlisted one (the browser refuses to render). No http:// sibling
    // source is minted for allowlisted hosts anymore.
    const allow = ["'self'", ...row.allowlist.flatMap((h) => (h.startsWith("*.") ? [`https://${h}`, `https://*.${h.slice(2)}`] : [`https://${h}`]))];
    res.setHeader("Content-Security-Policy", `frame-ancestors ${allow.join(" ")}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      res.end(readFileSync(path.join(webDist, "index.html"), "utf8"));
    } catch {
      res.status(502).end("widget shell unavailable");
    }
  });

  // Join-link shell (group 6): top-level full page; same token lane, no
  // frame-ancestors requirement (these links are opened, never embedded).
  app.get("/zhiyu/join/:token", (req, res) => {
    const row = widgetEnabled ? verifyWidgetToken(store, req.params.token) : null;
    if (!row || row.kind !== "link") return res.status(404).json({ error: "not found" });
    const room = store.roomGet(row.roomId);
    if (!room || !webDist) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      res.end(readFileSync(path.join(webDist, "index.html"), "utf8"));
    } catch {
      res.status(502).end("page unavailable");
    }
  });

  // visit: mint/reuse a guest seat on this room's token.
  app.post("/zhiyu/widget/:token/visit", express.json({ limit: "8kb" }), (req, res) => {
    const ctx = authorizeWidget(req, res);
    if (!ctx) return;
    const { row, room } = ctx;
    if (!takeToken(`visit:${req.ip}`, 20, 60_000)) return res.status(429).json({ error: "rate limited" });
    let seat = guestSeat(req, row);
    let ttyOut = null;
    if (!seat) {
      const ref = guestRefFor();
      const member = store.memberAdd({ roomId: row.roomId, kind: "guest", ref, display: `访客 · ${(cookieHost(req) ?? "guest").split(":")[0]}`, historyGrant: "join_from", invitedBy: "widget" });
      emit(row.roomId, "system", "", { event: "guest_joined", member: { id: member.id, display: member.display } });
      // AI-free greeting (polish batch): first contact names the callable seats
      // — the visitor learns `@` exists without burning a model turn. Every
      // active seat is named (polish-zhiyu-reception-welcome-line): a hard cap
      // of 3 left the fourth agent callable-but-unadvertised, so pointing at it
      // never happened. Only a very large roster is abbreviated, and then the
      // line says so.
      const activeSeats = store
        .membersOf(row.roomId)
        .filter((m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active")
        .map((m) => m.display || m.ref);
      const GREETING_SEAT_CAP = 6;
      const agents = activeSeats.slice(0, GREETING_SEAT_CAP);
      if (agents.length) {
        const more = activeSeats.length > GREETING_SEAT_CAP ? ` 等 ${activeSeats.length} 席` : "";
        store.messageAppend({
          roomId: row.roomId,
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
            const fresh = store.roomGet(row.roomId);
            if (!fresh || fresh.status !== "active") return;
            // The "has anyone spoken since this visitor joined?" test must read
            // the TAIL, not seq 0: a room with more than one window of history
            // would find the join event inside the first page and conclude that
            // guests have already been answered (polish-zhiyu-reception-welcome-line).
            const laterRows = store.messagesTail(row.roomId, 200, { viewerMemberId: null });
            const guestSeq = laterRows.findLast?.((m) => m.meta?.event === "guest_joined")?.seq ?? null;
            const since = guestSeq == null ? [] : laterRows.filter((m) => m.seq > guestSeq && (m.kind === "human" || m.kind === "agent"));
            if (since.length) return;
            const duty = store
              .membersOf(row.roomId)
              .find((m) => (m.kind === "facade" || m.kind === "agent") && m.state === "active");
            if (!duty) return;
            void Promise.resolve(
              router.directiveTurn({
                room: fresh,
                targetRef: duty.ref,
                directive: `一位访客刚进来,暂时还没有人说话。请你以自己的身份,用一两句温暖简洁的话欢迎他/她,并说出你能帮上什么(不要追问他答复,不要说教或念规则)。`,
              }),
            ).catch((err) => console.error(`[zhiyu] proactive greeting failed for ${row.roomId}:`, err.message));
          } catch (err) {
            console.error("[zhiyu] proactive greeting timer failed:", err.message);
          }
        }, proactiveDelayMs);
        proactiveTimers.add(pending);
      }
      seat = { member };
      const issued = serveGuestPass(row.roomId, ref);
      res.setHeader("Set-Cookie", issued.setCookie);
      ttyOut = issued.tty;
    }
    res.json({ ok: true, ref: seat.member.ref, display: seat.member.display, memberId: seat.member.id, tty: ttyOut ?? req.query.tty ?? null, roomId: row.roomId, title: room.title });
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

  app.get("/api/zhiyu/widget/:token/messages", (req, res) => {
    const ctx = authorizeWidget(req, res, { requireHost: false });
    if (!ctx) return;
    const seat = guestSeat(req, ctx.row);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    const has = (k) => req.query[k] !== undefined && req.query[k] !== "";
    if ((has("after") && has("before")) || (has("after") && has("tail")) || (has("before") && has("tail"))) {
      return res.status(400).json({ error: "after, before and tail are mutually exclusive" });
    }
    const rawLimit = has("limit") ? Number(req.query.limit) : 200;
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) return res.status(400).json({ error: "limit must be a positive number" });
    const limit = Math.min(Math.floor(rawLimit), 500);
    const viewerMemberId = seat.member.id;
    const enrich = widgetSenderOf(ctx.row.roomId);
    // Same window contract as the in-room route, through the SAME reader: bare
    // = after 0 (compat), ?tail=N = first-screen window, ?before=N = earlier.
    const raw = readWindow({
      roomId: ctx.row.roomId,
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
    const ctx = authorizeWidget(req, res, { requireHost: false });
    if (!ctx) return;
    const seat = guestSeat(req, ctx.row);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    const roomId = ctx.row.roomId;
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

  app.post("/api/zhiyu/widget/:token/messages", express.json({ limit: "16kb" }), (req, res) => {
    const ctx = authorizeWidget(req, res);
    if (!ctx) return;
    const { row, room } = ctx;
    if (room.status !== "active") return res.status(409).json({ error: "room ended" });
    const seat = guestSeat(req, row);
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

  app.get("/api/zhiyu/widget/:token/events", (req, res) => {
    const ctx = authorizeWidget(req, res, { requireHost: false });
    if (!ctx) return;
    const seat = guestSeat(req, ctx.row);
    if (!seat) return res.status(401).json({ error: "guest pass required" });
    const roomId = ctx.row.roomId;
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

  app.post("/api/zhiyu/widget/:token/identify", express.json({ limit: "8kb" }), (req, res) => {
    const ctx = authorizeWidget(req, res);
    if (!ctx) return;
    const { row, room } = ctx;
    const seat = guestSeat(req, row);
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

  // ── IM bridge machine lanes (add-zhiyu-im-bridge) ──────────────────────────
  // The cell-side bridge calls these with the gateway secret: ingest of IM
  // group messages as room guest rows, and a bot-scoped read-only event
  // subscription face back to the cell. Registered before the 404 catch-all.
  registerZhiyuImBridge(app, { store, humanMessageHook, secret: guestSecret || secret });

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
