// Fleet event wake (add-fleet-event-wake; authorization lane woven in by
// add-turn-mandate-lane).
//
// The FIRST bound external signal source: a social-chat bot's inbound message
// (server/bots.js) wakes a fleet post. No bus, no routing table, no wildcard
// subscriptions — one existing signal source, declared event edges, manual
// turns. The bot's own session turn is UNTOUCHED (it answers the chat; the
// post does fleet work asynchronously — the dual-turn is the owner's declared
// choice). One guard: per post per hour, honest refusal rows over the cap.
//
// add-turn-mandate-lane: every wake decision now passes the source's signal
// policy (server/fleet-turn-mandate.js). With NO policy file (the default),
// the gate admits edge hits exactly as before — byte-identical wakes — and
// every task records its immutable mandate; every inbound message gets a
// disposition row. observe shadows new surfaces (would_accept, never wakes);
// auto admits non-edge candidates through a matched rule, which also names
// the route (the rule's `target` post).

import { rosterPresetId } from "../dsh-profile.js";
import { derivedLaneCarrier } from "./fleet-events.js";
import { readSignalPolicy, admitTrigger, buildMandate, recordDisposition } from "./fleet-turn-mandate.js";

const buckets = new Map(); // `${fleetId}:${memberId}` → timestamps[]

function hourlyCap() {
  const n = Number(process.env.FLEET_EVENT_WAKE_HOURLY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function take(key) {
  const now = Date.now();
  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (stamps.length >= hourlyCap()) {
    buckets.set(key, stamps);
    return false;
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return true;
}

// The wake prompt envelope — ONE builder so edge wakes and rule wakes read
// the same shape (byte-identical for edge wakes, the red line).
function wakePrompt(source, senderName, chatKey, text) {
  return (
    `【事件唤醒】外部信号源 ${source} 收到来自「${senderName ?? "未知发送者"}」的消息(聊天 ${chatKey ?? "-"}):\n` +
    String(text ?? "").slice(0, 4000)
  );
}

// Resolve a rule-named target across non-archived fleets (persona/a2a only —
// the same target domain the edge lane admits).
function findRuleTarget(db, memberId) {
  for (const fleet of db.listFleets()) {
    if (fleet.state === "archived") continue;
    const target = db.getMember(memberId);
    // persona-only: 事件边目标集合（persona 或 a2a）；审计官不被事件唤醒
    if (target && target.fleetId === fleet.id && (target.targetKind === "persona" || target.targetKind === "a2a")) {
      return { fleet, target };
    }
  }
  return null;
}

function createWakeTask(engine, roster, { fleet, target, source, senderName, chatKey, text, mandate, ruleId = null, coalesced = 1 }) {
  return engine.createManualTask({
    prompt:
      wakePrompt(source, senderName, chatKey, text) +
      // add-fleet-edge-context D1: the woken post gets the fleet view too — the
      // message is its assignment, the background follows. Persona only.
      // persona-only: 事件边的唤醒目标；审计官不被事件唤醒
  (target.targetKind === "persona" ? "\n\n{{fleetEdgeContext}}" : ""),
    ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: roster(target.targetId) }),
    sessionTitle: `事件 · ${target.title}`,
    origin: {
      fleet: { fleetId: fleet.id, memberId: target.id, depth: 0 },
      // `coalesced` = how many inbound messages this one wake carries
      // (add-event-wake-coalesce): 1 is the old one-message-one-turn shape.
      event: {
        botId: mandate.trigger.botId,
        chatKey: chatKey ?? null,
        ...(ruleId ? { rule: ruleId } : {}),
        ...(coalesced > 1 ? { coalesced } : {}),
      },
      mandate,
    },
  });
}

// Scan the (non-archived) fleets' event edges for `bot:<botId>` and wake each
// bound post. Pure-dependency injection (db/engine/roster) so tests drive it
// without the app; returns the created task list for the log. `meta.addressed`
// is the bots.js mention heuristic (v1: bot name appears in the text) — only
// the non-edge table rows read it.
// ── Coalescing window (add-event-wake-coalesce) ─────────────────────────────
//
// A chat bot's inbound burst is one conversation, not N assignments: "在吗" +
// "帮我看下昨天的数" + 一张图 arrives as three webhooks within seconds, and each
// used to wake the bound post with its own turn — three runs, three payments,
// and the post answering three fragments. The window below collects messages
// for the SAME (bot, chat) for a short moment and wakes ONCE with the merged
// conversation.
//
// Off switch: `EVENT_WAKE_COALESCE_MS=0` restores the previous behavior
// exactly (synchronous, one wake per message) — tests and any caller that
// needs the immediate task id use it.
//
// Honesty: the merged wake records how many messages it carries (`coalesced`),
// and messages are truncated with a mark, never silently dropped. A process
// death inside the window loses the buffered messages — the window is short on
// purpose; that window is the price of not paying for N turns.
const COALESCE_MESSAGES_MAX = 8;
const COALESCE_TEXT_MAX = 4000;

export function coalesceWindowMs() {
  const v = Number(process.env.EVENT_WAKE_COALESCE_MS ?? 800);
  return Number.isFinite(v) && v >= 0 ? v : 800;
}

const pendingWakes = new Map(); // `${botId}:${chatKey ?? "-"}` → slot

// Merge a burst into the one message the wake lane understands. Sender = the
// last human who spoke (that is who the post should answer); addressed = any
// message mentioned the bot.
export function mergeWakeMessages(messages) {
  const kept = messages.slice(-COALESCE_MESSAGES_MAX);
  const dropped = messages.length - kept.length;
  const body = kept
    .map((m) => String(m.text ?? "").trim())
    .filter(Boolean)
    .join("\n---\n");
  const bounded =
    body.length > COALESCE_TEXT_MAX
      ? `${body.slice(0, COALESCE_TEXT_MAX)}…（消息过长已截断）`
      : body;
  const header = dropped > 0 ? `（此前另有 ${dropped} 条同类消息已合并/略去）\n` : "";
  const lastSender = [...kept].reverse().find((m) => m.senderName)?.senderName ?? null;
  return {
    senderName: lastSender,
    text: `${header}${bounded}`,
    addressed: kept.some((m) => m.addressed === true),
    coalesced: messages.length,
  };
}

// Deliver every buffered burst NOW (tests, and graceful shutdown paths).
export function flushEventWakes() {
  const keys = [...pendingWakes.keys()];
  const out = [];
  for (const key of keys) out.push(...flushWakeKey(key));
  return out;
}

function flushWakeKey(key) {
  const slot = pendingWakes.get(key);
  if (!slot) return [];
  pendingWakes.delete(key);
  if (slot.timer) clearTimeout(slot.timer);
  const merged = mergeWakeMessages(slot.messages);
  return deliverFleetEventWake(slot.deps, slot.botId, { chatKey: slot.chatKey, ...merged });
}

export function triggerFleetEventWake(deps, botId, meta = {}) {
  const windowMs = coalesceWindowMs();
  if (windowMs <= 0) return deliverFleetEventWake(deps, botId, meta); // coalescing off
  const key = `${botId}:${meta.chatKey ?? "-"}`;
  let slot = pendingWakes.get(key);
  if (!slot) {
    slot = { botId, chatKey: meta.chatKey ?? null, deps, messages: [], timer: null };
    pendingWakes.set(key, slot);
  }
  // The newest wiring wins: a restart or a re-registered bridge must use the
  // current db/engine handles when the timer fires.
  slot.deps = deps;
  slot.messages.push({
    senderName: meta.senderName ?? null,
    text: meta.text ?? "",
    addressed: meta.addressed === true,
    at: Date.now(),
  });
  if (!slot.timer) {
    slot.timer = setTimeout(() => flushWakeKey(key), windowMs);
    // Never hold the process open for a buffered wake.
    if (typeof slot.timer.unref === "function") slot.timer.unref();
  }
  return []; // nothing is created until the window closes
}

function deliverFleetEventWake({ db, engine, roster = rosterPresetId }, botId, { chatKey, senderName, text, addressed = false, coalesced = 1 } = {}) {
  const source = `bot:${botId}`;
  const policy = readSignalPolicy(botId);
  const created = [];
  const now = Date.now();
  let sawEdge = false;
  for (const fleet of db.listFleets()) {
    if (fleet.state === "archived") continue;
    const edges = (fleet.orchestration?.edges ?? []).filter((e) => e?.kind === "event" && e.from === source);
    for (const e of edges) {
      sawEdge = true;
      const target = db.getMember(e.to);
      if (!target || target.fleetId !== fleet.id) continue;
      // persona-only: 同上——只唤醒 persona/a2a 目标
  if (target.targetKind !== "persona" && target.targetKind !== "a2a") continue;
      const gate = admitTrigger({ policy, edgeHit: true, senderName, text });
      if (!gate.admitted) {
        recordDisposition(botId, { fate: "filtered", reason: gate.reason, chatKey: chatKey ?? null, sender: senderName ?? null, post: target.id });
        continue;
      }
      if (!take(`${fleet.id}:${target.id}`)) {
        recordDisposition(botId, { fate: "cap_refused", reason: "hourly_cap", chatKey: chatKey ?? null, sender: senderName ?? null, post: target.id });
        db.appendTurnEvent({
          fleetId: fleet.id,
          memberId: target.id,
          source: "event",
          status: "failed",
          errorKind: "other",
          error: `event wake hourly cap (${hourlyCap()}) reached for bot '${botId}' — message dropped for this post, honestly`,
          startedAt: now,
          endedAt: now,
          sessionId: null,
          // Derived-lane marking (add-turn-metering挂账): the wake was refused —
          // the row carries the lane it BELONGS to.
          metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
        });
        continue;
      }
      const mandate = buildMandate({
        strength: gate.strength,
        via: gate.via,
        row: gate.row,
        cell: gate.cell,
        policy,
        botId,
        chatKey,
        senderName,
      });
      const task = createWakeTask(engine, roster, { fleet, target, source, senderName, chatKey, text, mandate, coalesced });
      recordDisposition(botId, {
        fate: "admitted",
        reason: "edge_hit",
        ...(coalesced > 1 ? { coalesced } : {}),
        chatKey: chatKey ?? null,
        sender: senderName ?? null,
        post: target.id,
        taskId: task.id,
        strength: gate.strength,
        policyVersion: mandate.policyVersion,
      });
      created.push({ fleetId: fleet.id, memberId: target.id, taskId: task.id });
    }
  }
  if (!sawEdge) {
    if (policy.mode === "off") {
      // The current behavior for an unmatched message: nothing. The
      // disposition row is the new honest record of that nothing.
      recordDisposition(botId, { fate: "filtered", reason: "off_mode", chatKey: chatKey ?? null, sender: senderName ?? null });
    } else {
      // observe/auto assess the non-edge surface. Routing is structural: the
      // matched rule's `target` names the post (admitTrigger guarantees a
      // ruleId on any non-edge admission).
      const gate = admitTrigger({ policy, edgeHit: false, senderName, addressed: addressed === true, text });
      if (gate.wouldAccept) {
        recordDisposition(botId, { fate: "would_accept", reason: gate.reason, ruleId: gate.ruleId ?? null, chatKey: chatKey ?? null, sender: senderName ?? null });
      } else if (gate.admitted) {
        const found = findRuleTarget(db, policy.rules.find((r) => r.id === gate.ruleId)?.target);
        if (!found) {
          recordDisposition(botId, { fate: "filtered", reason: "rule_target_unresolved", ruleId: gate.ruleId ?? null, chatKey: chatKey ?? null, sender: senderName ?? null });
        } else if (!take(`${found.fleet.id}:${found.target.id}`)) {
          recordDisposition(botId, { fate: "cap_refused", reason: "hourly_cap", ruleId: gate.ruleId ?? null, chatKey: chatKey ?? null, sender: senderName ?? null, post: found.target.id });
        } else {
          const mandate = buildMandate({
            strength: gate.strength,
            via: gate.via,
            row: gate.row,
            cell: gate.cell,
            ruleId: gate.ruleId,
            policy,
            botId,
            chatKey,
            senderName,
          });
          const task = createWakeTask(engine, roster, {
            ...found,
            source,
            senderName,
            chatKey,
            text,
            mandate,
            ruleId: gate.ruleId,
            coalesced,
          });
          recordDisposition(botId, {
            fate: "admitted",
            reason: "rule_match",
        ...(coalesced > 1 ? { coalesced } : {}),
            ruleId: gate.ruleId ?? null,
            chatKey: chatKey ?? null,
            sender: senderName ?? null,
            post: found.target.id,
            taskId: task.id,
            strength: gate.strength,
            policyVersion: mandate.policyVersion,
          });
          created.push({ fleetId: found.fleet.id, memberId: found.target.id, taskId: task.id });
        }
      } else {
        recordDisposition(botId, { fate: "filtered", reason: gate.reason, chatKey: chatKey ?? null, sender: senderName ?? null });
      }
    }
  }
  return created;
}
