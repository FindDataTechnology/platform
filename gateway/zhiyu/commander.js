// ── The room commander: ONE bounded decision before any seat speaks ──────────
//
// Why this exists (2026-11-19, production): a group message 「本周产品线进展」 produced
//   +0.0s human / +32.6s pass / +44.1s pass / +44.1s all_passed
// — 44 seconds, and not one character reached the group. The router had no LLM
// step at all: it matched `@name` by regex and, failing that, asked every seat
// in turn "do you want to say something?". Each seat decided for itself. Nobody
// was responsible for the round, so the round could legally produce nothing.
//
// This module is the responsible party. It makes ONE bounded call, returns a
// STRUCTURED decision (never free prose), and the router dispatches from it.
//
// Why structured: a decision that is prose cannot be validated, degraded, or
// tested. The common model failure is "said a great deal, decided nothing" —
// a schema turns that into a detectable null instead of a silent broadcast.
//
// Why it rides the existing `voiceRoute` seam instead of a new one: that seam
// has carried the answer-shaped contract since add-voice-routing 3.1
// ({recipients, basis, reason}) and was never supplied by anything, so every
// room broadcast. A commander is a better supplier of the same shape, and the
// router needs no new branch.

const DECISION_TIMEOUT_MS = 12_000;

export const COMMANDER_INTENTS = ["greeting", "meta", "task", "chitchat", "unclear"];

/**
 * Parse the model's answer into a decision, or null.
 *
 * Null is a first-class result: the caller degrades to today's broadcast path and
 * records that it did. Anything half-formed is null — an invented seat, a
 * missing dispatch, both selfAnswer and dispatch set. Guessing here would put a
 * fabricated decision in the room's history.
 */
export function parseDecision(raw, { seats = [] } = {}) {
  let obj = raw;
  if (typeof raw === "string") {
    // Models fence JSON often enough that stripping the fence is not leniency,
    // it is the actual contract.
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const intent = COMMANDER_INTENTS.includes(obj.intent) ? obj.intent : "unclear";
  const known = new Set(seats.map((s) => s.id));
  const rawDispatch = Array.isArray(obj.dispatch) ? obj.dispatch : [];
  const dispatch = [];
  let hallucinated = 0;
  for (const d of rawDispatch) {
    const seatId = typeof d?.seatId === "string" ? d.seatId : null;
    // A seat the room does not have cannot be dispatched to. Drop it and count
    // it; NEVER fail the whole round over one invented name.
    if (!seatId || !known.has(seatId)) {
      hallucinated += 1;
      continue;
    }
    if (dispatch.some((x) => x.seatId === seatId)) continue; // dedupe, keep first
    dispatch.push({ seatId, points: typeof d.points === "string" ? d.points.trim().slice(0, 800) : "" });
  }

  const selfAnswer = obj.selfAnswer === true;
  // The two ways of answering are mutually exclusive by construction. Both set
  // means the model did not decide; that is exactly the null case.
  if (selfAnswer && dispatch.length) return null;
  const noOneReason = typeof obj.noOneReason === "string" ? obj.noOneReason.trim().slice(0, 300) : null;
  if (!selfAnswer && !dispatch.length && !noOneReason) return null; // decided nothing

  return {
    intent,
    dispatch,
    selfAnswer,
    receipt: obj.receipt === true || dispatch.length > 0, // a dispatch is always preceded by a receipt
    noOneReason,
    hallucinated,
  };
}

/** The prompt. Deliberately short: the commander has one job, and a long prompt
 *  invites the model to start answering instead of routing. */
export function buildCommanderPrompt({ room, sender, message, seats }) {
  const roster = seats
    .map((s) => `- id=${s.id} 名字=${s.display || s.ref}${s.onBehalfOf ? `（代 ${s.onBehalfOf} 出席）` : ""}`)
    .join("\n");
  return [
    `你是空间「${room.title || room.id}」的指挥官。你的工作不是回答问题，是决定这一轮怎么处理。`,
    `在场席位：`,
    roster || "（无）",
    ``,
    `规则：`,
    `1. 寒暄、对空间本身的元问题（如「你能做什么」）→ selfAnswer=true，由你自己简短回应，不要惊动席位。`,
    `2. 需要具体席位处理的 → dispatch 指定 seatId，并在 points 写清要它处理什么（不是转述原话）。`,
    `3. 一条消息含多个独立诉求 → dispatch 多个。`,
    `4. 确实无人能答 → dispatch 为空且 selfAnswer=false，并在 noOneReason 写一句给用户看的理由。`,
    `5. 只能写下面 JSON，不要任何解释文字：`,
    `{"intent":"greeting|meta|task|chitchat|unclear","dispatch":[{"seatId":"...","points":"..."}],"selfAnswer":false,"receipt":true,"noOneReason":null}`,
    ``,
    `${sender.display || sender.ref} 说：${message.content}`,
  ].join("\n");
}

/**
 * Build the commander. Returns a `voiceRoute`-compatible function: it yields a
 * decision for every message (that is the whole point — no more "not my
 * policy"), or null when the commander itself failed, which the router records
 * as a degradation and handles with the legacy broadcast.
 */
export function createCommander({
  callCommander,
  log = console,
  timeoutMs = DECISION_TIMEOUT_MS,
  enabled = () => false,
  /**
   * Called the moment the commander starts thinking, BEFORE the model answers.
   * The decision takes as long as any model call; without this the group waits
   * that whole time in silence — which is the exact complaint this whole module
   * exists to answer (2026-11-19: 44 seconds of nothing). Best-effort: a failure
   * here must never stop the decision.
   */
  onThinking = null,
} = {}) {
  return async function commanderRoute({ room, member, message, agents }) {
    if (!enabled()) return null;
    const seats = (Array.isArray(agents) ? agents : []).filter(
      (m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active",
    );
    if (!seats.length) return null; // nobody to route to; the router's own no-target path is clearer

    // Say "on it" immediately, then think. Whoever is waiting in the group learns
    // that the message LANDED within a second or two, instead of inferring
    // "broken" from silence.
    if (typeof onThinking === "function") {
      try {
        onThinking({ room, member, message });
      } catch (err) {
        log.warn(`[zhiyu:commander] thinking marker failed for ${room.id}: ${err?.message || err}`);
      }
    }

    const prompt = buildCommanderPrompt({ room, sender: member, message, seats });
    let raw;
    try {
      raw = await Promise.race([
        callCommander(prompt, { seats }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("commander timeout")), timeoutMs)),
      ]);
    } catch (err) {
      log.warn(`[zhiyu:commander] decision failed for ${room.id} (degrading to broadcast): ${err?.message || err}`);
      return null;
    }

    const decision = parseDecision(raw, { seats });
    if (!decision) {
      log.warn(`[zhiyu:commander] unusable decision for ${room.id} (degrading to broadcast): ${String(raw).slice(0, 160)}`);
      return null;
    }
    if (decision.hallucinated) {
      log.warn(`[zhiyu:commander] dropped ${decision.hallucinated} dispatch(es) naming seats this room does not have`);
    }
    // A decision with nothing to dispatch and no self-answer still carries a
    // REASON, which the router renders — that is how "nobody suitable" stops
    // being indistinguishable from "the bot is down".
    if (decision.selfAnswer) {
      return { basis: "commander", reason: decision.noOneReason ?? null, recipients: [], selfAnswer: true, intent: decision.intent };
    }
    if (!decision.dispatch.length) {
      return { basis: "commander_none", reason: decision.noOneReason, recipients: [], selfAnswer: false, intent: decision.intent };
    }
    return {
      basis: "commander",
      reason: null,
      recipients: decision.dispatch.map((d) => ({ id: d.seatId, points: d.points })),
      selfAnswer: false,
      intent: decision.intent,
      receipt: decision.receipt,
    };
  };
}
