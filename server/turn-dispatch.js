// Turn dispatch — the single arbiter for web-lane prompts
// (concurrent-chat-sessions, design D1/D2/D5/D8).
//
// The shared dsh child runs ONE open turn at a time: dsh 0.2.0-rc.2 cannot
// close a turn while another session's request is parked (contract ⑨, see
// scripts/lib/dsh-contracts/contracts.mjs). Every web prompt therefore goes
// through dispatchTurn(): it dispatches immediately only when the runtime is
// idle and otherwise QUEUES the prompt, never rejecting it for busyness and
// never putting a second turn into the child. A queued prompt keeps its own
// session's viewers informed (queued / dequeued) and can be cancelled before
// it ever reaches the runtime.
//
// "Busy" is deliberately wider than the web lane (design D2): scheduled tasks,
// bots and delegation summaries run in the SAME child but are tracked only by
// sessionCollectors, and a lane that committed to prompt but is not yet
// observable (a cron preset switch restarting the child) holds a reservation.
// Reading isStreaming alone — as the pre-change code did — missed both and
// would let the dispatcher collide with them.
//
// Policies (design D8): `queue` (default) queues while busy; `concurrent`
// dispatches regardless (only valid on a dsh matrix that passes contract ⑨b);
// `legacy` reproduces the pre-change behavior and exists for rollback.

export const POLICIES = ["legacy", "queue", "concurrent"];

// Policy resolution is a deployment capability statement, not a user choice:
// `concurrent` is refused unless the matrix was marked as passing the strict
// close-interleave contract (⑨b) — a future dsh-upgrade change sets that flag
// together with the version bump.
export function resolvePolicy(env = process.env) {
  const requested = String(env.TURN_DISPATCH || "queue").trim().toLowerCase();
  if (!POLICIES.includes(requested)) {
    return { policy: "queue", requested, downgraded: true, reason: `unknown TURN_DISPATCH '${requested}'` };
  }
  if (requested === "concurrent" && env.DSH_MATRIX_CLOSE_INTERLEAVE !== "1") {
    return {
      policy: "queue",
      requested,
      downgraded: true,
      reason:
        "TURN_DISPATCH=concurrent requires a dsh matrix that passes contract ⑨b " +
        "(set DSH_MATRIX_CLOSE_INTERLEAVE=1 with the upgrade)",
    };
  }
  return { policy: requested, requested, downgraded: false, reason: null };
}

export function attachTurnDispatch(ctx) {
  if (typeof ctx.dispatchTurn === "function") return ctx; // idempotent

  const resolved = resolvePolicy();
  ctx.dispatchPolicy = resolved.policy;
  ctx.dispatchPolicyRequested = resolved.requested;
  if (resolved.downgraded) {
    console.warn(`[turn-dispatch] ${resolved.reason}; running the 'queue' policy`);
  }

  const MAX_QUEUE = Number(process.env.TURN_QUEUE_MAX || 8);
  const POLL_MS = Number(process.env.TURN_QUEUE_POLL_MS || 2000);

  // sid -> { sessionId, text, run, ws, seq, waitingOn }. One entry per session;
  // `seq` makes FIFO explicit (and testable) rather than relying on Map order.
  ctx.turnQueue = new Map();
  let seq = 0;
  let pollTimer = null;

  // Lanes that committed to prompt but are not yet observable in
  // sessionCollectors (cron's preset switch restarts the child, and its
  // bridge.ready would otherwise drain the queue into the restart window).
  ctx.runtimeReservations = ctx.runtimeReservations || new Set();
  ctx.reserveRuntime = (label = "lane") => {
    const token = { label };
    ctx.runtimeReservations.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      ctx.runtimeReservations.delete(token);
    };
  };

  // "Is the shared child busy anywhere" — web turns plus every non-web lane
  // visible through its collector plus pending reservations. Worker-pool
  // children use their own collector maps and never appear here; they run in
  // separate processes and are not subject to the one-turn constraint.
  // `exceptSid` excludes the caller's own synchronous reservation (the ws
  // layer sets the in-flight guard before the first await, then asks us to
  // dispatch that very prompt).
  ctx.runtimeBusy = (exceptSid = null) => {
    if (ctx.runtimeReservations.size > 0) return true;
    if ((ctx.sessionCollectors?.size ?? 0) > 0) return true;
    if (!ctx.isStreaming) return false;
    if (!exceptSid) return true;
    const open = typeof ctx.streamingSessions === "function" ? ctx.streamingSessions() : [];
    return open.some((sid) => sid !== exceptSid);
  };

  // The web session whose turn is open, for the queue bubble's "waiting on".
  const openWebSession = () => {
    const open = typeof ctx.streamingSessions === "function" ? ctx.streamingSessions() : [];
    return open[0] ?? null;
  };

  const waitingOnField = () => {
    const sid = openWebSession();
    if (!sid) return null; // busy on a non-web lane (scheduled task / bot)
    return { id: sid, title: ctx.db?.getSessionMeta?.(sid)?.title || null };
  };

  const queuePosition = (sid) => {
    const ordered = [...ctx.turnQueue.values()].sort((a, b) => a.seq - b.seq);
    return ordered.findIndex((e) => e.sessionId === sid) + 1;
  };

  const queuedView = (entry) => ({
    text: entry.text,
    position: queuePosition(entry.sessionId),
    waitingOn: entry.waitingOn ?? null,
  });

  ctx.isQueuedFor = (sid) => Boolean(sid) && ctx.turnQueue.has(sid);
  ctx.queuedSessions = () => [...ctx.turnQueue.keys()];
  ctx.turnStatusFor = (sid) =>
    ctx.isStreamingFor(sid) ? "running" : ctx.isQueuedFor(sid) ? "queued" : null;
  ctx.queuedViewFor = (sid) => {
    const entry = ctx.turnQueue.get(sid);
    return entry ? queuedView(entry) : null;
  };

  const startRun = (sessionId, run) => {
    // Called synchronously (not through a microtask): run() is an async
    // function whose own body starts executing immediately up to its first
    // await, which is exactly the dispatch semantics the guard relies on.
    // run() owns its turn close on failure; this catch only keeps an escaping
    // rejection from becoming unhandled.
    try {
      Promise.resolve(run(sessionId)).catch((err) =>
        console.error("[turn-dispatch] run failed:", err?.message || err),
      );
    } catch (err) {
      console.error("[turn-dispatch] run threw synchronously:", err?.message || err);
      // A synchronous throw before any await would otherwise leave the session
      // wedged as streaming forever.
      ctx.finishTurn?.(undefined, sessionId);
    }
  };

  // A prompt is "accepted" once it is dispatched or queued — the demo budget
  // is consumed here (design D4: submitting consumes, cancelling does not
  // refund). Rejections happen before this point.
  //
  // `reserved`: the caller already set the in-flight guard for `sessionId`
  // synchronously (chat-streaming's pre-await latch). We must not read that
  // latch as "someone else is busy", and on the queue branch we release it.
  ctx.dispatchTurn = ({ sessionId, text, run, ws = null, onAccepted = null, reserved = false }) => {
    if (!sessionId || typeof run !== "function") {
      return { accepted: false, reason: "invalid" };
    }
    // Same-session guard, synchronously before any await: two prompts for one
    // session in the same tick cannot both pass.
    if (ctx.isQueuedFor(sessionId) || (ctx.isStreamingFor(sessionId) && !reserved)) {
      return { accepted: false, reason: "session_busy" };
    }

    const dispatchNow = () => {
      // Synchronous reservation of the turn before run()'s first await
      // (chat-streaming: the guard is set at dispatch). Idempotent when the
      // caller already reserved.
      ctx.setStreaming(sessionId, true);
      ctx.turnStateFor(sessionId).promptStopped = false;
      ctx.resetTurnBuffer?.(sessionId);
      onAccepted?.();
      void ctx.broadcastSessions?.();
      startRun(sessionId, run);
    };

    const policyDispatchesNow =
      ctx.dispatchPolicy === "concurrent" ||
      ctx.dispatchPolicy === "legacy" ||
      !ctx.runtimeBusy(reserved ? sessionId : null);

    if (policyDispatchesNow) {
      dispatchNow();
      return { accepted: true, dispatched: true, queued: false };
    }

    if (ctx.turnQueue.size >= MAX_QUEUE) {
      // Nothing was accepted: release the caller's latch so the session is
      // not left looking busy for a prompt that never entered the queue.
      if (reserved) ctx.setStreaming(sessionId, false);
      return { accepted: false, reason: "queue_full" };
    }

    const entry = { sessionId, text, run, ws, seq: ++seq, waitingOn: waitingOnField() };
    ctx.turnQueue.set(sessionId, entry);
    if (reserved) ctx.setStreaming(sessionId, false);
    onAccepted?.();
    ctx.sendToViewers?.(sessionId, { type: "queued", ...queuedView(entry) });
    void ctx.broadcastSessions?.();
    ensurePoll();
    return { accepted: true, dispatched: false, queued: true, position: queuePosition(sessionId) };
  };

  // Remove a queued prompt without touching the runtime (stop_turn on a
  // session whose turn never started).
  ctx.cancelQueued = (sessionId) => {
    const entry = ctx.turnQueue.get(sessionId);
    if (!entry) return false;
    ctx.turnQueue.delete(sessionId);
    ctx.turnStateBySession.delete(sessionId);
    ctx.sendToViewers?.(sessionId, { type: "dequeued", reason: "cancelled" });
    void ctx.broadcastSessions?.();
    stopPollIfIdle();
    return true;
  };

  // Dispatch the head of the queue when the runtime is free. Called on every
  // idle transition (finishTurn, collector close, bridge ready) and by the
  // safety poll. Synchronous up to the reservation, so a re-entrant call
  // cannot double-dispatch.
  ctx.drainTurnQueue = () => {
    if (ctx.dispatchPolicy !== "queue") return;
    if (ctx.turnQueue.size === 0) {
      stopPollIfIdle();
      return;
    }
    if (ctx.runtimeBusy()) {
      ensurePoll();
      return;
    }
    const next = [...ctx.turnQueue.values()].sort((a, b) => a.seq - b.seq)[0];
    if (!next) return;
    ctx.turnQueue.delete(next.sessionId);
    ctx.setStreaming(next.sessionId, true);
    ctx.turnStateFor(next.sessionId).promptStopped = false;
    ctx.resetTurnBuffer?.(next.sessionId);
    ctx.sendToViewers?.(next.sessionId, { type: "dequeued", reason: "dispatched" });
    void ctx.broadcastSessions?.();
    startRun(next.sessionId, next.run);    // One dispatch per idle transition: the turn is now open, so the next
    // drain happens when it closes.
    stopPollIfIdle();
  };

  // Safety net: a lane that forgets to signal idle must not strand a queued
  // prompt forever. The poll is not the primary path — every known exit calls
  // drainTurnQueue directly.
  function ensurePoll() {
    if (pollTimer || !(POLL_MS > 0)) return;
    pollTimer = setInterval(() => ctx.drainTurnQueue(), POLL_MS);
    pollTimer.unref?.();
  }
  function stopPollIfIdle() {
    if (!pollTimer) return;
    if (ctx.turnQueue.size === 0) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // The runtime may have just become idle: a web turn closed, a non-web lane's
  // collector left sessionCollectors (the ONLY trace such a turn leaves), or
  // the child (re)started. A roster restart the catalog sync had to defer goes
  // first — dispatching onto the stale child would only have that restart kill
  // the turn; it reserves the runtime, so the drain parks until it is done.
  ctx.onRuntimeIdle = () => {
    ctx.flushCatalogPresetRestart?.();
    ctx.drainTurnQueue();
  };

  return ctx;
}
