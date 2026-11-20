// ── Outbound message gate (add-principal-disclosure-gate 1.x/2.x/4.x) ───────
//
// The one door an outbound message may leave through. Everything a message needs
// in order to be sent — the adapter, the destination — is passed INTO this
// function; no module keeps a directly usable send configuration of its own.
// That is the structural half of "no bypass": there is nothing to bypass with.
//
// The behavioural half is that the disclosure verdict is computed on the TEXT
// THAT WILL BE SENT, never on a summary. A summary is built by the same model
// that wrote the text; trusting it to describe the text is trusting the thing
// under audit.
//
// What this deliberately does NOT do: claim a bypass is impossible. Any module
// can still reach a platform API directly. The design's answer is that the
// attempt is detectable and recorded (see noteBypassAttempt), not that it is
// unthinkable.

import crypto from "node:crypto";
import { DECISION, canAutoSendAtLevel, resolveMandate } from "./personal-mandate.js";

export const OUTBOUND_ACTION = Object.freeze({
  id: "chat.message.send",
  risk: "write",
  outbound: true,
  // The field that carries "what is being said". Declared here so the gate reads
  // the real text; an outbound entry without this fails the registry check.
  contentArgs: ["text"],
});

export const IDENTITY_MODES = Object.freeze({
  INTERNAL: "internal",
  EXTERNAL: "external",
});

function digest(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

/**
 * Render the same content in the two identity forms (4.1).
 *
 * Internal audiences see that an agent wrote this. External audiences do not —
 * which is the entire point of an outward-facing agent, and exactly why the
 * accountability trail has to exist instead: the disclosure lives in the ledger
 * and the on-demand receipt, not in every message.
 *
 * The content itself is identical in both forms. Two divergent bodies would mean
 * the owner approves A and the platform sends B.
 */
export function renderForAudience({ text, mode, label = "AI 代理" }) {
  if (mode === IDENTITY_MODES.INTERNAL) return `【${label}】${text}`;
  return text;
}

/**
 * Gate one outbound message.
 *
 * Returns:
 *   { ok: true,  decision: 'execute', text, disclosure, ledger }
 *   { ok: false, decision: 'draft'|'advise', reason, disclosure }
 *   { ok: false, decision: 'fallback' }   — no mandate applies, caller decides
 */
export function gateOutboundMessage({
  policy,
  domain,
  text,
  to,
  channel,
  principal,
  declaredSources = [],
  sensitiveTerms = [],
  usage = { count: 0, amount: 0 },
  now = Date.now(),
  // 渠道能否撤回 (5.2)。默认 false：未声明的渠道按不可撤回处理——这是保守
  // 方向。撤不回的消息被自动发出，事后通报只是通知事故。
  channelRevocable = false,
  // 层级样本 (5.1)：只有本次命中的层级自己攒够样本，才允许自动对外发言。
  levelSamples = null,
  minLevelSamples = 20,
} = {}) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, decision: "advise", reason: "empty_message" };
  }

  const action = { ...OUTBOUND_ACTION, revocable: true };
  const verdict = resolveMandate({
    policy,
    domain,
    action,
    args: { text },
    principal,
    usage,
    now,
    declaredSources,
    sensitiveTerms,
  });

  const base = { disclosure: verdict.disclose ?? null, verdict, action };

  if (verdict.decision === DECISION.FALLBACK) {
    return { ...base, ok: false, decision: "fallback", reason: "no_mandate" };
  }
  if (verdict.decision === DECISION.ADVISE) {
    return { ...base, ok: false, decision: "advise", reason: verdict.reasons[0] ?? "advise" };
  }
  if (verdict.decision === DECISION.DRAFT) {
    return { ...base, ok: false, decision: "draft", reason: verdict.reasons[0] ?? "draft" };
  }

  // 自动对外发送的两个额外门槛（5.1 / 5.2）。任一不满足 → 回落 draft，
  // 并给出具体缺项，而不是笼统的「不允许」。
  if (verdict.mode === "act-notify" || verdict.mode === "act-silent") {
    if (!channelRevocable) {
      return { ...base, ok: false, decision: "draft", reason: "channel_not_revocable" };
    }
    if (levelSamples) {
      const levelGate = canAutoSendAtLevel({ level: highestLevel(declaredSources) ?? "public", levelSamples, minSamples: minLevelSamples });
      if (!levelGate.ok) {
        return { ...base, ok: false, decision: "draft", reason: levelGate.reason, levelGate };
      }
    }
  }

  const revokeWindow = verdict.mandateRef?.revokeWindowMinutes ?? null;
  const ledger = {
    principal: principal?.email ?? principal?.id ?? null,
    // Recipient and channel together: "to whom" is meaningless without "where",
    // and the same person can be reached on two channels with different rules.
    audience: to ? `${channel ?? "unknown"}:${to}` : channel ?? null,
    domain: domain ?? null,
    mode: verdict.mode,
    discloseLevel: verdict.disclose && !verdict.disclose.ok ? null : highestLevel(declaredSources),
    contentDigest: digest(text),
    reversibleUntil: revokeWindow ? now + revokeWindow * 60_000 : null,
  };

  return { ...base, ok: true, decision: "execute", text, ledger };
}

/**
 * The strictest provenance level the message drew on. Kept separate from the
 * violation path: a clean message still has a level, and the promotion gate
 * counts samples per level.
 */
function highestLevel(sources = []) {
  const order = ["public", "internal", "confidential", "hr", "finance"];
  let best = null;
  for (const source of sources) {
    const level = source?.level;
    if (!order.includes(level)) continue;
    if (best === null || order.indexOf(level) > order.indexOf(best)) best = level;
  }
  return best;
}

/**
 * Record an attempt to send outside the gate. Not a refusal (we cannot stop code
 * that never asked), but the record is what turns an untestable promise
 * ("there is no bypass") into an observable event.
 */
export function noteBypassAttempt({ onRecord, source = "unknown", detail = null } = {}) {
  const entry = { type: "outbound_bypass_attempt", source, detail, at: Date.now() };
  try {
    onRecord?.(entry);
  } catch {
    /* detection must never break the caller */
  }
  return entry;
}
