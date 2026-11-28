// Fleet decision lane core (agent-fleet-decision-lane).
//
// Pure/injectable logic for the owner's approval queue: escalate payload
// validation (question/options/severity; suggestedDeadline is display-only),
// the optimistic state machine's legal-transition map, the delivery segment
// the patrol-context injector renders (approved/rejected items awaiting their
// delivery turn, ≤5 per turn, rolling), and the execute-now prompt. Storage
// lives in fleets-db (transitionDecision = first-writer-wins); HTTP/tool
// faces live in routes/fleets.js and server/fleet-mcp.js.

export const SEVERITIES = ["low", "normal", "high"];
export const DECISION_STATES = ["open", "approved", "rejected", "expired", "delivered"];
// A delivered turn may carry at most this many decisions (design: the rest
// roll to the next turn — a patrol prompt must not explode).
export const INJECTED_PER_TURN = 5;
export const OPEN_QUEUE_LIMIT = 50;

// Legal state transitions (design D2). delivered/rejected-after-delivery are
// terminal; expired is owner-reopenable only.
export const DECISION_TRANSITIONS = {
  open: ["approved", "rejected", "expired"],
  expired: ["open"], // owner's explicit reopen
  approved: ["delivered"],
  rejected: ["delivered"],
  delivered: [],
};

export function transitionAllowed(from, to) {
  return (DECISION_TRANSITIONS[from] ?? []).includes(to);
}

// ── escalate payload validation ──────────────────────────────────────────────

// { question ≤500, options 2..6 of {value,label}, severity, suggestedDeadline?
// (display only), recommendation? (must name an option value) }
export function validateEscalatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "escalate payload must be an object" };
  }
  const { question, options, severity, suggestedDeadline, recommendation } = payload;
  if (!question || typeof question !== "string" || !question.trim()) {
    return { ok: false, error: "question is required" };
  }
  if (question.length > 500) {
    return { ok: false, error: "question exceeds 500 characters" };
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
    return { ok: false, error: "options must be an array of 2 to 6 entries" };
  }
  const seen = new Set();
  for (const opt of options) {
    if (!opt || typeof opt.value !== "string" || !opt.value.trim() || typeof opt.label !== "string" || !opt.label.trim()) {
      return { ok: false, error: "each option needs a value and a label" };
    }
    if (seen.has(opt.value)) return { ok: false, error: "option values must be unique" };
    seen.add(opt.value);
  }
  if (severity !== undefined && !SEVERITIES.includes(severity)) {
    return { ok: false, error: `severity must be one of ${SEVERITIES.join(", ")}` };
  }
  if (suggestedDeadline !== undefined && suggestedDeadline !== null && typeof suggestedDeadline !== "string") {
    return { ok: false, error: "suggestedDeadline must be a human-readable string (display only)" };
  }
  if (recommendation !== undefined && recommendation !== null) {
    if (typeof recommendation !== "string" || !seen.has(recommendation)) {
      return { ok: false, error: "recommendation must name one of the submitted option values" };
    }
  }
  // 委托扩展 (add-deputy-decision-delegate)：可选类别（策略路由的依据）与可选
  // topicKey（提交方声明的去重主题）。显式校验——非法值报错而非静默降级。
  const optionalText = (value, max, name) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return { error: `${name} must be a string` };
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > max) return { error: `${name} exceeds ${max} characters` };
    return trimmed;
  };
  const category = optionalText(payload.category, 40, "category");
  if (category && category.error) return category;
  const topicKey = optionalText(payload.topicKey, 120, "topicKey");
  if (topicKey && topicKey.error) return topicKey;

  // 事项来源（2026-11-10）。个人事务域的映射靠它落域：此前这里不认 `source`，
  // 于是 payload.item.source 恒为 undefined、`domainFor(map, null)` 恒 null、
  // decision_items.domain 永远是 null —— 映射配了也永远不会有一个事项落进去。
  // 未知来源按显式错误拒绝（拼错等于永不触发，和「没有配置」长得一样）。
  const source = optionalText(payload.source, 40, "source");
  if (source && source.error) return source;
  if (source && !SOURCES.includes(source)) {
    return { ok: false, error: `source must be one of ${SOURCES.join(", ")}` };
  }

  return {
    ok: true,
    item: {
      question: question.trim(),
      options: options.map((o) => ({ value: o.value.trim(), label: o.label.trim() })),
      severity: severity ?? "normal",
      suggestedDeadline: suggestedDeadline ?? null,
      recommendation: recommendation ?? null,
      category,
      topicKey,
      source: source ?? null,
    },
  };
}

// ── Resolution validation (approve / reject / amend) ─────────────────────────

// Amend = approve with a corrected choice. The QUESTION text is immutable by
// design — changing the question is a new escalation, so an amend body that
// carries a differing `question` is refused outright.
export function validateResolution(kind, body, item) {
  const values = new Set(item.options.map((o) => o.value));
  const note = body?.note !== undefined && body?.note !== null ? String(body.note).slice(0, 1000) : null;
  if (kind === "reject") {
    return { ok: true, resolution: { kind: "reject", choice: null, note, by: null, at: null } };
  }
  const choice = body?.choice;
  if (typeof choice !== "string" || !values.has(choice)) {
    return { ok: false, error: `choice must be one of: ${[...values].join(", ")}` };
  }
  if (kind === "amend" && body?.question !== undefined && body.question !== item.question) {
    return { ok: false, error: "amend cannot rewrite the question — submit a new escalation instead" };
  }
  return {
    ok: true,
    resolution: { kind: kind === "amend" ? "amend" : "approve", choice, note, by: null, at: null },
  };
}

// ── Delivery segment (the injector's decision block) ────────────────────────

function resolutionLine(item) {
  const r = item.resolution;
  const label =
    item.options.find((o) => o.value === r?.choice)?.label ?? r?.choice ?? "";
  if (r?.kind === "reject") {
    return `裁定：驳回${r.note ? `。理由：${r.note}` : ""}`;
  }
  const kindText = r?.kind === "amend" ? "改批（修正选项后批准）" : "批准";
  return `裁定：${kindText}——${label}${r?.note ? `。批注：${r.note}` : ""}`;
}

// Render the decisions segment for ONE post's delivery turn: its
// approved/rejected items not yet delivered, oldest resolution first, capped
// at INJECTED_PER_TURN; items beyond the cap roll to a later turn. Null when
// there is nothing to deliver (the injector then omits the segment entirely —
// no empty placeholder).
export function renderDecisionSegment(items, { limit = INJECTED_PER_TURN } = {}) {
  const deliverable = items.filter(
    (i) => (i.state === "approved" || i.state === "rejected") && i.deliveredAt == null,
  );
  if (deliverable.length === 0) return null;
  const page = deliverable
    .slice()
    .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
    .slice(0, limit);
  const lines = ["【主人拍板结果】以下决定已由主人裁定，请在本回合执行/知悉："];
  for (const item of page) {
    lines.push(`- 问题：${item.question}`);
    lines.push(`  ${resolutionLine(item)}`);
  }
  const rest = deliverable.length - page.length;
  if (rest > 0) lines.push(`（另有 ${rest} 条裁定将随后续回合送达）`);
  return lines.join("\n");
}

// The execute-now prompt: the decision context alone, framed as a turn. For a
// cadence post this rides the promptOverride path; for a passive post it
// becomes a manual task's whole prompt.
export function buildExecuteNowPrompt(items) {
  const segment = renderDecisionSegment(items);
  return `主人在拍板队列作出了裁定，请立即处理：\n\n${segment ?? "（无待送达裁定）"}`;
}
import { SOURCES } from "../lib/personal-domain-map.js";
