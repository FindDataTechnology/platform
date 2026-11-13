// ── Zhiyu round router (add-zhiyu-room, design D-B) ──────────────────────────
//
// The room's turn protocol, deliberately LLM-free: @mentions dispatch
// targeted agent turns; an unaddressed human message solicits every active
// agent/facade seat ONCE (each may reply or pass with 「过」); answers from
// agent seats never re-enter the router as triggers (the hard circuit
// breaker — agent messages are appended by THIS file only, and nothing here
// calls back into onHumanMessage for them). Fuses: per-trigger non-pass
// answer cap (two-level config), one open turn per (room, agent) with a busy
// mark otherwise, facades in `listening` presence are not broadcast-eligible
// (their principal took over).
//
// Dispatch is sequential: one gateway process, small caps — order and cost
// stay predictable; parallelizing later is a delivery optimization, not a
// protocol change.

import { EventEmitter } from "node:events";

import { observeTurnTap } from "../../server/observe-tap.js";
import { matchMentions } from "./voice-router.js";

export function createRoomRouter({
  store,
  effectiveCap,
  callAgent, // (member, { text, contextId, onDelta }) → { text }
  settleTurn = null, // (member, { usageId, minutes }) → void — per-DEPLOYMENT billing (group 7)
  onBudgetWarning = null, // (room, dayTurns, budget) → void — 80% daily-budget nudge (website-embed)
  bus = null, // EventEmitter for ephemeral overlay events (deltas/lifecycle)
  contextWindow = 40,
  // Memory seam (unified-memory-and-outputs D7): ({ sender, query, room, target })
  // → the block to append, or "" for none. The wiring decides identity (guests
  // never inject); this file only appends, and any failure degrades open.
  memoryBlock = null,
  // Voice routing seam (add-voice-routing 3.1): ({ room, member, message, agents })
  // → a decideAddressee() result, or null to mean "not this room's policy".
  // Null is the DEFAULT and it is the whole safety property: with no seam, or a
  // room that has not opted in, the room behaves exactly as it does today.
  voiceRoute = null,
}) {
  const overlay = bus ?? new EventEmitter();
  const inFlight = new Set(); // `${roomId}:${memberId}`

  // Dispatch cancellation (add-voice-routing 4.3). The router dispatches
  // sequentially, so "not yet started" is exactly the tail of `targets` — and
  // cancelling is a flag checked before each turn, never a rollback. A turn that
  // already ran is billed and stays; the stop semantics for it are the room's
  // existing ones, not this flag.
  const cancelledTriggers = new Set(); // `${roomId}:${triggerKey}`
  // How to name one human message across cancel/reassign calls.
  const triggerKeyOf = (message) => String(message?.seq ?? message?.id ?? "");

  const PASS_MARK = "「过」";

  // The prompt the seat is asked with = room context + the asking party's
  // memory block (when the wiring offers one). Memory never fails a turn.
  async function promptWithMemory({ room, target, sender, message, mode }) {
    const base = buildPrompt({ room, agentMember: target, sender, message, mode });
    if (!memoryBlock) return base;
    try {
      const block = await memoryBlock({ sender, query: message?.content ?? "", room, target });
      return block ? `${base}\n\n${block}` : base;
    } catch (e) {
      console.warn(`[zhiyu-memory] injection failed (degrade open): ${e?.message || e}`);
      return base;
    }
  }

  // Same rule as before, now living in voice-router.js so the voice decision and
  // the room cannot drift apart on what counts as a mention (add-voice-routing 2.1).
  // The alias that used to sit here (`namesFor = sharedNamesFor`) went dead when
  // the mention parsing moved; kept as a note so the next reader does not
  // re-introduce a second copy of the rule.

  // @mention parsing: first-hit per name, case-insensitive, `@名字` anywhere
  // in the message. Display-name collisions resolve to the earliest joiner —
  // the roster UI should keep displays distinct (and aliases disambiguate).
  function resolveMentions(content, agents) {
    return matchMentions(content, agents);
  }
  /**
   * Map a routing recipient onto a seat that can actually answer.
   *
   * A decision names TEAMS (that is the unit with a budget and a quota). A turn
   * needs a SEAT. The link is not implicit, so try, in order: an explicit
   * `seatId` from the seam, an agent seat carrying that `teamId`, a seat whose id
   * IS the recipient, then a ref match (`acme/sales` ↔ seat `acme/sales` or the
   * seat named by the handle's first segment). No match = no dispatch, and the
   * caller logs it.
   */
  function resolveSeat(recipient, agents) {
    if (!recipient) return null;
    if (recipient.seatId) {
      const bySeatId = agents.find((m) => m.id === recipient.seatId);
      if (bySeatId) return bySeatId;
    }
    const byId = agents.find((m) => m.id === recipient.id);
    if (byId) return byId;
    const byTeam = agents.find((m) => m.teamId && m.teamId === recipient.id);
    if (byTeam) return byTeam;
    const refs = [recipient.ref, recipient.handle, String(recipient.ref ?? "").split("/")[0]]
      .map((r) => String(r ?? "").trim())
      .filter(Boolean);
    for (const ref of refs) {
      const byRef = agents.find((m) => m.ref === ref || m.handle === ref);
      if (byRef) return byRef;
    }
    return null;
  }

  // Room-context prompt assembly (group 6 refines the privacy partition; the
  // partition LIVES here already: shared transcript window + the facade's own
  // private window with its principal — and nothing else, no private memory).
  function buildPrompt({ room, agentMember, sender, message, mode }) {
    const rows = store.messagesAfter(room.id, 0, { viewerMemberId: null, limit: 10_000 })
      .filter((m) => m.visibility === "shared" && (m.kind === "human" || m.kind === "agent" || m.kind === "system"))
      .filter((m) => m.kind !== "system" || m.meta?.event === "hatched_history" || m.meta?.event === "room_hatched")
      .slice(-contextWindow);
    const members = new Map(store.membersOf(room.id).map((m) => [m.id, m]));
    const label = (m) => {
      if (m.provenance) return "（升房历史）";
      const senderMember = m.senderMemberId ? members.get(m.senderMemberId) : null;
      if (m.kind === "human") return senderMember?.display || senderMember?.ref || "成员";
      if (m.kind === "agent") return senderMember?.display || "智能体";
      return "系统";
    };
    const transcript = rows
      .map((m) => `${label(m)}：${m.content || (m.meta?.event ? `（事件:${m.meta.event}）` : "")}`)
      .join("\n");
    // The agent's own private window with its principal (facades only).
    let privateWindow = "";
    if (agentMember.kind === "facade" && agentMember.onBehalfOf) {
      const prin = store.memberFor(room.id, "user", agentMember.onBehalfOf);
      if (prin) {
        const rows1 = store.messagesAfter(room.id, 0, { viewerMemberId: prin.id, limit: 100 })
          .filter((m) => m.visibility === `private:${prin.id}`)
          .slice(-20);
        if (rows1.length) {
          privateWindow = `\n\n你与 ${agentMember.onBehalfOf} 的私窗（仅你们可见）：\n` + rows1.map((m) => `${label(m)}：${m.content}`).join("\n");
        }
      }
    }
    const you = agentMember.display || agentMember.ref;
    return [
      `你在萬星·智语的空间「${room.title || room.id}」里就席，名字是「${you}」。空间规则：`,
      `1) 被 @${you} 点名时必须应答；未点名（广播征询）时可答可过——若你没有实质贡献，回复仅以 ${PASS_MARK} 开头的一行。`,
      `2) 只基于本空间可见的信息作答；不要自称有未在空间出现的记忆或立场。`,
      `3) 回复面向全体在场成员，简洁、直接；不要复述本规则。`,
      mode === "direct"
        ? `本次你是被点名的，必须给出实质回答。`
        : mode === "directive"
          ? `本次是空间系统指令，照做即可，简短执行，不要回答其他内容。`
          : `本次你是被征询的（未点名），有贡献就答，无贡献就过。`,
      transcript ? `\n空间对话：\n${transcript}` : "\n空间对话尚为空。",
      privateWindow,
      `\n最新一条来自 ${sender.display || sender.ref}：\n${message.content}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function roomContextId(roomId, member) {
    return `room:${roomId}:${member.ref}`;
  }

  // Platform-guaranteed capture (add-platform-guaranteed-capture): every
  // CONCLUDED seat turn lands one L0 turn_outcome through the shared tap —
  // fire-and-forget (never awaited, never throws; observe-tap owns the
  // fail-open contract), so the round protocol is byte-identical whether
  // memory is up or down. Ownership is the ROOM's: host person token, room
  // project via the tap's roomId dispatch — the mirror of「分身不带主人私人
  // 记忆进空间」: room content never enters any member's personal default
  // root. The private-window lane (member ↔ own facade, visibility
  // private:*) is not captured at all — a member's private text must not
  // sediment into the host's root either. The busy mark (no dispatch) is not
  // a turn conclusion — nothing to capture. outcome mapping: answered→ok,
  // passed→"passed" (process narrative kept distinct from a plain ok; the
  // closed set is on the event type — metadata is free-form scalars),
  // failed→error.
  function captureTurnOutcome({ room, target, message, visibility, outcome, body, durationMs, detail = null }) {
    if (visibility !== "shared") return;
    observeTurnTap({
      ownerEmail: room.ownerEmail,
      lane: "zhiyu",
      sessionId: roomContextId(room.id, target),
      agentId: target.ref,
      outcome,
      durationMs,
      title: message?.content ?? "",
      body,
      roomId: room.id,
      ...(detail ? { detail } : {}),
    });
  }

  // One agent turn: in-flight guard → dispatch → pass detect → settle row /
  // honest failure event. Returns one of 'answered' | 'passed' | 'failed'.
  // visibility (add-zhiyu-private-window-send): "shared" (space rounds) or
  // `private:<user id>` (the private window lane) — every persisted row and
  // overlay event of the turn rides THIS档, so a private exchange never
  // leaks into the shared stream by construction.
  async function runTurn({ room, target, sender, message, mode, visibility = "shared" }) {
    const key = `${room.id}:${target.id}`;
    const display = target.display || target.ref;
    if (inFlight.has(key)) {
      store.messageAppend({
        roomId: room.id,
        kind: "event",
        content: "",
        visibility,
        meta: { event: "agent_busy", memberId: target.id, display },
      });
      return "failed";
    }
    inFlight.add(key);
    overlay.emit(room.id, { type: "agent_start", roomId: room.id, memberId: target.id, display, visibility });
    const startedAt = Date.now();
    try {
      const { text } = await callAgent(target, {
        text: await promptWithMemory({ room, target, sender, message, mode }),
        contextId: roomContextId(room.id, target),
        // The asking party's visitor scope (design D-C): matters a facade
        // opens from this turn bind to (room, asker).
        scopeSeed: `room:${room.id}:${sender.ref}`,
        onDelta: (delta) =>
          overlay.emit(room.id, { type: "agent_delta", roomId: room.id, memberId: target.id, display, delta, visibility }),
      });
      const trimmed = String(text ?? "").trim();
      if (!trimmed || trimmed.startsWith(PASS_MARK)) {
        store.messageAppend({
          roomId: room.id,
          kind: "event",
          content: "",
          visibility,
          meta: { event: "pass", memberId: target.id, display },
        });
        overlay.emit(room.id, { type: "agent_done", roomId: room.id, memberId: target.id, outcome: "pass", visibility });
        captureTurnOutcome({
          room, target, message, visibility,
          outcome: "passed", body: PASS_MARK, durationMs: Date.now() - startedAt,
        });
        return "passed";
      }
      const { row } = store.messageAppend({
        roomId: room.id,
        kind: "agent",
        senderMemberId: target.id,
        fromAgent: 1,
        visibility,
        content: trimmed,
        replyToSeq: message.seq,
        meta: { mode },
      });
      // Settle the answer against the SEAT'S deployment billing key (spec:
      // 计费与配额挂钩 — speech is billed, passes and failures are not).
      // usage id is idempotency-keyed upstream, so a redelivered settle is
      // safe. Failure here must not eat the answer — it settles as usage
      // that the ops sweep handles, with a loud warn.
      const dayTurns = store.roomConsumeTurnBudget(room.id);
      if (room.dailyBudgetTurns != null && onBudgetWarning) {
        const pct = dayTurns / room.dailyBudgetTurns;
        if (pct >= 0.8 && pct < 1 + 1 / room.dailyBudgetTurns) {
          try {
            onBudgetWarning(room, dayTurns, room.dailyBudgetTurns);
          } catch (err) {
            console.warn(`[zhiyu] budget warning hook failed for ${room.id}: ${err.message}`);
          }
        }
      }
      if (settleTurn) {
        const minutes = Math.max(1, Math.ceil((Date.now() - startedAt) / 60_000));
        // usage id carries the guest scope explicitly (spec: 计费归属与熔断) —
        // a guest-triggered answer is traceable to the guest seat via the
        // trigger seq AND the seat's own suffix.
        const guestTag = sender?.kind === "guest" ? "-guest" : "";
        const privateTag = visibility !== "shared" ? "-private" : "";
        try {
          await settleTurn(target, { usageId: `zyr-${room.id}-${row.seq}-${target.id}${guestTag}${privateTag}`, minutes });
        } catch (err) {
          // An unbilled answer must be visible as a fact, not a console line
          // (fix-zhiyu-seat-settle-missing-billing-key D2): a missing billing
          // key meant every demo turn answered free while nobody noticed.
          const unbilled = err?.code === "NO_BILLING_KEY";
          if (unbilled) {
            // expected=true only when the room DECLARED itself a showcase
            // (declare-zhiyu-keyless-showcase-rooms): same row, different
            // meaning — "free by design" vs "someone forgot a billing key".
            const expected = room.billingMode === "showcase";
            store.messageAppend({
              roomId: room.id,
              kind: "event",
              content: "",
              visibility: "shared",
              meta: { event: "settle_unbilled", memberId: target.id, display, seq: row.seq, code: err.code, minutes, expected },
            });
            console.warn(
              `[zhiyu] settle unbilled (no billing key, ${expected ? "expected: showcase room" : "CONFIG GAP"}) for ${target.ref} in ${room.id} (seq ${row.seq})`,
            );
            captureTurnOutcome({
              room, target, message, visibility,
              outcome: "ok", body: trimmed, durationMs: Date.now() - startedAt,
              detail: { unbilled: "no_billing_key", settleCode: err.code },
            });
          } else {
            console.warn(`[zhiyu] settle failed for ${target.ref} in ${room.id} (seq ${row.seq}): ${err.message}`);
          }
        }
      }
      overlay.emit(room.id, { type: "agent_done", roomId: room.id, memberId: target.id, outcome: "answered", seq: row.seq, visibility });
      captureTurnOutcome({
        room, target, message, visibility,
        outcome: "ok", body: trimmed, durationMs: Date.now() - startedAt,
      });
      return "answered";
    } catch (err) {
      const message = String(err?.message ?? "unknown");
      const insolvent = /402|quota|insufficient|balance|欠费|余额/i.test(message);
      // Retryable vs not (clarify-zhiyu-guest-failure-copy): production showed
      // every guest the same "接待席位暂时出了点问题", but 8 of 12 real
      // failures were 429/5xx/connection — i.e. BUSY, where asking again would
      // have worked. The split is shown to visitors; the raw reason never is
      // (it carries packIds, upstream URLs and status codes).
      const retryable =
        /(^|\D)429(\D|$)|(^|\D)5\d\d(\D|$)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|Connection error|timed? ?out|aborted/i.test(
          message,
        );
      store.messageAppend({
        roomId: room.id,
        kind: "event",
        content: "",
        visibility,
        meta: {
          event: insolvent ? "agent_declined_insolvent" : "agent_failed",
          memberId: target.id,
          display,
          reason: message.slice(0, 200),
          ...(insolvent ? {} : { retryable }),
        },
      });
      overlay.emit(room.id, { type: "agent_done", roomId: room.id, memberId: target.id, outcome: "failed", visibility });
      captureTurnOutcome({
        room, target, message, visibility,
        outcome: "error",
        body: String(err?.message ?? "unknown").trim().slice(0, 200) || "unknown",
        durationMs: Date.now() - startedAt,
      });
      return "failed";
    } finally {
      inFlight.delete(key);
    }
  }

  // The only entry point — wired to the human-message POST route.
  async function onHumanMessage({ room, member, message }) {
    const fresh = store.roomGet(room.id);
    if (!fresh || fresh.status !== "active") return;
    const agents = store
      .membersOf(room.id)
      .filter((m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active");
    if (!agents.length) return;
    const mentioned = resolveMentions(message.content, agents);
    // Broadcast eligibility excludes listening facades (principal took over).
    const legacyTargets = mentioned.length ? mentioned : agents.filter((m) => m.kind === "agent" || m.presence !== "listening");

    // A room may opt into voice routing; every other room keeps the line above
    // untouched. `decision === null` is the documented "not my policy" answer.
    let targets = legacyTargets;
    let routeDecision = null;
    if (voiceRoute) {
      try {
        routeDecision = voiceRoute({ room: fresh, member, message, agents, mentioned });
      } catch (err) {
        // A router failure must never drop a human's message: fall back to the
        // legacy targets and record that the decision was unavailable.
        console.warn(`[zhiyu] voice route failed (degrade to broadcast): ${err?.message || err}`);
        routeDecision = null;
      }
    }
    if (routeDecision) {
      const mapped = [];
      for (const recipient of routeDecision.recipients ?? []) {
        const seat = resolveSeat(recipient, agents);
        if (seat && !mapped.some((m) => m.id === seat.id)) mapped.push(seat);
        else if (!seat) {
          // A team with no seat in this room cannot be woken. Say so rather than
          // silently shrinking the recipient list into a no-op.
          console.warn(`[zhiyu] route recipient ${recipient?.id ?? recipient?.ref ?? "?"} has no seat in ${room.id}`);
        }
      }
      targets = mapped;
      // 4.1: the decision is a room EVENT, readable afterwards, carrying the
      // candidates and the reason so 「为什么派给了他」 has an answer.
      store.messageAppend({
        roomId: room.id,
        kind: "event",
        content: "",
        visibility: "shared",
        meta: {
          event: "route_decision",
          kind: routeDecision.basis,
          reason: routeDecision.reason,
          recipients: (routeDecision.recipients ?? []).map((r) => r.id ?? r.ref ?? null).filter(Boolean),
          candidates: (routeDecision.candidates ?? []).map((r) => r.id ?? r.ref ?? null).filter(Boolean),
          seq: null,
        },
      });
    }
    if (!targets.length) return;
    const cap = effectiveCap(fresh);
    let answered = 0;
    let budgetNoted = false;
    for (const target of targets) {
      if (cancelledTriggers.has(`${room.id}:${triggerKeyOf(message)}`)) {
        const remaining = targets.slice(targets.indexOf(target));
        store.messageAppend({
          roomId: room.id,
          kind: "event",
          content: "",
          visibility: "shared",
          meta: {
            event: "route_cancelled",
            skipped: remaining.length,
            skippedSeats: remaining.map((t) => t.ref ?? t.id).filter(Boolean),
            answeredBeforeStop: answered,
          },
        });
        break;
      }
      if (answered >= cap) {
        store.messageAppend({
          roomId: room.id,
          kind: "event",
          content: "",
          meta: { event: "reply_cap_hit", effective: cap, skipped: target.display || target.ref },
        });
        continue;
      }
      // Owner-set daily answer budget (spec: 计费与配额挂钩): touching the
      // ceiling pauses agent speech honestly, human lanes never notice.
      if (fresh.dailyBudgetTurns != null && store.roomDayTurnsPeek(room.id) >= fresh.dailyBudgetTurns) {
        if (!budgetNoted) {
          budgetNoted = true;
          store.messageAppend({
            roomId: room.id,
            kind: "event",
            content: "",
            meta: { event: "budget_exhausted", effective: fresh.dailyBudgetTurns },
          });
        }
        continue;
      }
      const mode = mentioned.length ? "direct" : "solicit";
      const outcome = await runTurn({ room: fresh, target, sender: member, message, mode });
      if (outcome === "answered") answered += 1;
    }
    if (!mentioned.length && targets.length && answered === 0) {
      store.messageAppend({
        roomId: room.id,
        kind: "event",
        content: "",
        meta: { event: "all_passed", targetCount: targets.length },
      });
    }
  }

  // The private window lane (add-zhiyu-private-window-send): a member↔their
  // own facade 1:1 exchange. Everything persisted here rides the member's
  // private档 (runTurn visibility), the room's daily budget still counts (the
  // room is the spend), and the billing settles on the facade's deployment key
  // with a `-private` attribution suffix. Not a broadcast round: no @ parsing,
  // no solicit, no reply-cap accounting (one question → at most one answer).
  async function dispatchPrivateTurn({ room, sender, message }) {
    const fresh = store.roomGet(room.id);
    if (!fresh || fresh.status !== "active") return false;
    const facade = store
      .membersOf(room.id)
      .find((m) => m.kind === "facade" && m.onBehalfOf === sender.ref && m.state === "active");
    if (!facade) return false;
    const visibility = `private:${sender.id}`;
    // Same daily-budget gate as the broadcast round (spec: 计费与配额挂钩) —
    // the private lane counts against the room ceiling too, and the honest
    // refusal rides the member's private档, never the shared stream.
    if (fresh.dailyBudgetTurns != null && store.roomDayTurnsPeek(room.id) >= fresh.dailyBudgetTurns) {
      store.messageAppend({
        roomId: room.id,
        kind: "event",
        content: "",
        visibility,
        meta: { event: "budget_exhausted", effective: fresh.dailyBudgetTurns },
      });
      return false;
    }
    const outcome = await runTurn({
      room: fresh,
      target: facade,
      sender: { ref: sender.ref, display: sender.display, id: sender.id, kind: sender.kind },
      message,
      mode: "private",
      visibility,
    });
    return outcome === "answered";
  }

  // System-directed single turn (call/announce lanes): bypasses the answer
  // cap and the broadcast rules — it is a room-level instruction, not part
  // of any member-triggered round. Directive turns ride the same in-flight
  // guard and the same honest failure events.
  async function directiveTurn({ room, targetRef, directive }) {
    const fresh = store.roomGet(room.id);
    if (!fresh || fresh.status !== "active") return false;
    const target = store
      .membersOf(room.id)
      .find((m) => (m.kind === "facade" || m.kind === "agent") && m.state === "active" && m.ref === targetRef);
    if (!target) return false;
    const outcome = await runTurn({
      room: fresh,
      target,
      sender: { ref: "system", display: "系统" },
      message: { seq: null, content: directive },
      mode: "directive",
    });
    return outcome === "answered";
  }

  /**
   * Stop dispatching the rest of one human message (4.3).
   *
   * Returns how many targets had not started yet — that number is what the room
   * is told, and it is the honest one: turns already run are billed and stand.
   */
  function cancelDispatch({ roomId, triggerSeq, by = null }) {
    const key = `${roomId}:${String(triggerSeq ?? "")}`;
    if (!String(triggerSeq ?? "")) return { ok: false, code: "trigger_required" };
    cancelledTriggers.add(key);
    overlay.emit(roomId, { type: "route_cancelled", triggerSeq: String(triggerSeq), by });
    return { ok: true, triggerSeq: String(triggerSeq), by };
  }

  /**
   * Re-dispatch one utterance to different targets (4.4).
   *
   * Not a rewrite: the original route_decision stays exactly as it was, a
   * `route_reassigned` row records the new intent, and the new decision is its
   * own row. Anyone reading later sees both attempts and why the second happened.
   */
  async function reassignDispatch({ room, triggerSeq, targets, reason = "", by = null, decision = null }) {
    const fresh = store.roomGet(room.id);
    if (!fresh) return { ok: false, code: "room_not_found" };
    const seats = (targets ?? [])
      .map((t) => (typeof t === "string" ? store.membersOf(room.id).find((m) => m.id === t) : resolveSeat(t, store.membersOf(room.id))))
      .filter(Boolean);
    if (!seats.length) return { ok: false, code: "no_targets" };

    cancelledTriggers.add(`${room.id}:${String(triggerSeq ?? "")}`);
    store.messageAppend({
      roomId: room.id,
      kind: "event",
      content: "",
      visibility: "shared",
      meta: {
        event: "route_reassigned",
        triggerSeq: String(triggerSeq ?? ""),
        to: seats.map((s) => s.ref ?? s.id),
        reason: String(reason ?? "").slice(0, 300),
        by: by ?? null,
        basis: decision?.basis ?? "manual",
      },
    });
    // The words to deliver are the ones being confirmed — not the operator's
    // note about confirming them. `triggerSeq` names the original human row, so
    // the seat answers the question that was asked; the reason stays in the
    // route_reassigned event above as the audit trail. Before this, a
    // needs_confirmation row whose speaker was finally confirmed sent
    // 「由房间所有者手动改派」 as the latest message, and the agent answered a
    // note about the reassignment instead of the utterance.
    const seqNum = Number(triggerSeq);
    const trigger = Number.isInteger(seqNum) && seqNum > 0 ? store.messageAt(room.id, seqNum) : null;
    const utterance = String(trigger?.content ?? "").trim();
    for (const target of seats) {
      await runTurn({
        room: fresh,
        target,
        sender: { ref: by ?? "router" },
        message: utterance ? { seq: trigger.seq, content: utterance } : { content: reason },
        mode: "direct",
      });
    }
    return { ok: true, count: seats.length };
  }

  return {
    onHumanMessage,
    directiveTurn,
    dispatchPrivateTurn,
    cancelDispatch,
    reassignDispatch,
    resolveMentions,
    buildPrompt,
    promptWithMemory,
    roomContextId,
    overlay,
    PASS_MARK,
  };
}
