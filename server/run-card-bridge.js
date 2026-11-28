// ── Run Card bridge (run-card-bridge) ───────────────────────────────────────
//
// Transport only. A task-flow card can leave this process as a `run-card/1`
// envelope and come back unchanged; this module reads and writes no judgement.
// The criterion vocabulary and evaluator stay in task-flow.js — a second
// evaluator would drift, and the drift's symptom is the same evidence getting
// two verdicts.
//
// `source` is an uninterpreted passthrough: state, execution history and flow
// attribution ride along so the round trip is lossless. A session id is an
// executor address, not task identity, so it is deliberately not exported.

import { CARD_ASSERTION_KINDS, normalizeCardAcceptance } from "./task-flow.js";

function criterionOf(item) {
  const out = { id: item.id, kind: item.kind };
  for (const key of ["target", "expect", "rubric"]) {
    if (item[key] !== undefined && item[key] !== null) out[key] = item[key];
  }
  return out;
}

export function toRunCard(task, { deadlineSeconds, acceptance } = {}) {
  if (!task || typeof task.id !== "string" || !task.id) {
    throw new Error("run card export needs a task with a string id");
  }
  if (!Number.isFinite(Number(deadlineSeconds)) || Number(deadlineSeconds) <= 0) {
    throw new Error("run card export needs deadlineSeconds — task-flow has no deadline field and a default would be a fabricated constraint");
  }
  const criteria = Array.isArray(acceptance) ? acceptance : task.flow?.acceptance ?? [];
  const flow = task.flow && typeof task.flow === "object" ? { ...task.flow } : null;
  // A session id is an executor address, not task identity.
  if (flow) delete flow.sessionId;
  return {
    schema: "run-card/1",
    id: task.id,
    ...(typeof task.title === "string" ? { title: task.title } : {}),
    input: { prompt: typeof task.prompt === "string" ? task.prompt : "" },
    requires: { capabilities: [] },
    acceptance: criteria.map(criterionOf),
    budget: {},
    deadline: { seconds_max: Number(deadlineSeconds) },
    allowed_harnesses: [],
    source: {
      state: task.state ?? null,
      history: Array.isArray(task.history) ? task.history : [],
      flow,
    },
  };
}

export function fromRunCard(card) {
  if (!card || card.schema !== "run-card/1") {
    throw new Error("not a run-card/1 envelope");
  }
  if (typeof card.id !== "string" || !card.id) throw new Error("run card has no id");
  if (typeof card.input?.prompt !== "string") throw new Error("run card has no input.prompt");
  const deadlineSeconds = Number(card.deadline?.seconds_max);
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) {
    throw new Error("run card has no positive deadline.seconds_max");
  }

  const acceptance = Array.isArray(card.acceptance) ? card.acceptance : [];
  for (const [i, item] of acceptance.entries()) {
    if (!CARD_ASSERTION_KINDS.includes(item?.kind)) {
      throw new Error(`acceptance[${i}] declares kind '${item?.kind}' outside the task-flow vocabulary (${CARD_ASSERTION_KINDS.join(", ")})`);
    }
  }
  const normalized = normalizeCardAcceptance(acceptance);
  if (normalized.errors.length > 0) {
    throw new Error(normalized.errors.map((e) => e.error).join("; "));
  }

  const source = card.source && typeof card.source === "object" ? card.source : {};
  const flow = source.flow && typeof source.flow === "object" ? { ...source.flow } : null;
  // Never carry an executor address back in, even if a hand-written envelope has one.
  if (flow) delete flow.sessionId;

  return {
    id: card.id,
    prompt: card.input.prompt,
    ...(flow ? { flow: { ...flow, acceptance: normalized.assertions.map(criterionOf) } } : { acceptance: normalized.assertions.map(criterionOf) }),
    state: source.state ?? null,
    history: Array.isArray(source.history) ? source.history : [],
    deadlineSeconds,
  };
}
