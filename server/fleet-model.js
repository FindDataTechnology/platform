// Fleet post-model core (add-fleet-post-model).
//
// Two pure pieces shared by the write face and the turn path:
//   1. fleetModelChoiceError — the write-time gate, the SAME three gates the
//      serving deploy config uses (shape → roster → lanes when known), so a
//      fleet post and a served agent refuse illegal models with one voice.
//   2. resolveModelChain — the turn-time resolution chain
//      [post model, post fallback, fleet default, cell default]: deduped,
//      first roster hit wins. Declared-but-missing hops yield notices for the
//      turn's blocker trace; undeclared hops pass silently (inheritance is
//      normal, failure is an event). Write-time validity never guarantees
//      runtime validity — the roster drifts — which is exactly why the chain
//      exists (design D2/D5).

import { MODEL_ID_RE } from "../lib/pack-manifest.js";
import { modelChoiceError } from "../lib/agent-serving.js";

// Returns the error string or null. `roster`/`lanes` null = unknowable → that
// gate stays open (mirrors modelChoiceError's own degrade-open semantics).
export function fleetModelChoiceError({ model, roster = null, lanes = null }) {
  if (typeof model !== "string" || !MODEL_ID_RE.test(model)) {
    return `model '${model}' is not a valid model identifier`;
  }
  return modelChoiceError({ model, whitelist: null, lanes, roster });
}

const SOURCE_LABELS = {
  member: "post model",
  "member-fallback": "post fallback model",
  "fleet-default": "fleet default model",
  "cell-default": "cell default model",
};

// The chain, in resolution order. Returns:
//   candidates — roster-valid hops in order (all roster-valid when the roster
//                is unknown; the switch loop walks past one if drift bites)
//   effective  — candidates[0]?.model ?? null (null = honest turn failure)
//   notices    — one line per DECLARED hop the roster rejected
export function resolveModelChain({ model = null, fallbackModel = null, fleetDefault = null, cellDefault = null, roster = null }) {
  const declared = [
    { model, source: "member" },
    { model: fallbackModel, source: "member-fallback" },
    { model: fleetDefault, source: "fleet-default" },
    { model: cellDefault, source: "cell-default" },
  ];
  const seen = new Set();
  const chain = [];
  for (const hop of declared) {
    if (!hop.model || seen.has(hop.model)) continue;
    seen.add(hop.model);
    chain.push(hop);
  }
  const candidates = [];
  const notices = [];
  let landed = false;
  for (const hop of chain) {
    const alive = roster == null || roster.includes(hop.model);
    if (alive) {
      candidates.push(hop);
      landed = true;
    } else if (!landed) {
      // Only hops consulted BEFORE the landing are "fallen through"; hops past
      // the effective one are silent walk-past backups — noticing them would
      // cry wolf about models the turn never needed.
      notices.push(`declared ${SOURCE_LABELS[hop.source]} '${hop.model}' is not in the runner's model roster — falling through`);
    }
  }
  return { effective: candidates[0]?.model ?? null, candidates, notices };
}

// ── Agent effort resolution (add-agent-config-dims) ──────────────────────────
//
// The thinking depth has the same inherit-down shape as the model chain, but a
// DIFFERENT predicate: a model hop is valid when it is in the roster, an effort
// hop is valid when the EFFECTIVE MODEL declares that level. Kept as its own
// pure function rather than folded into resolveModelChain — one function
// carrying two predicates invites exactly the drift the chain was built to
// prevent.
//
// Why the declaration never reaches the dsh profile: dsh reads effort
// per-PROVIDER (dsh-profile.js), so writing per-agent levels into the profile
// would make two agents on the same provider overwrite each other. The level
// is applied per turn through the live model/set path instead.
export function resolveAgentEffort({ agentEffort = null, fleetEffort = null, cellEffort = null, model = null, roster = null } = {}) {
  const declared = [
    { effort: agentEffort, source: "post" },
    { effort: fleetEffort, source: "fleet" },
    { effort: cellEffort, source: "cell" },
  ].filter((h) => typeof h.effort === "string" && h.effort.length > 0);

  if (!declared.length) return { effort: null, source: null, notices: [] };

  const supported = supportedEffortsFor(model, roster);
  // Unknown model (not in the roster) means we cannot judge: pass the first
  // declaration through and let the runtime refuse honestly. Inventing a
  // "not supported" verdict here would block a turn over a roster hiccup.
  if (supported === null) return { effort: declared[0].effort, source: declared[0].source, notices: [] };

  const notices = [];
  for (const hop of declared) {
    if (supported.includes(hop.effort)) return { effort: hop.effort, source: hop.source, notices };
    notices.push(`declared ${hop.source} thinking level '${hop.effort}' is not supported by model '${model ?? "?"}' — falling through`);
  }
  return { effort: null, source: null, notices };
}

// The levels a model declares, or null when the model is unknown to the roster
// (callers must treat null as "cannot judge", not "supports nothing").
function supportedEffortsFor(model, roster) {
  if (!model) return null;
  if (Array.isArray(roster) && !roster.includes(model)) return null;
  return EFFORT_DECLARATIONS.get(model) ?? null;
}

// Model id → declared levels. Populated by the profile writer / model list
// builder, so this module stays dependency-free and unit-testable.
const EFFORT_DECLARATIONS = new Map();
export function setEffortDeclarations(map) {
  EFFORT_DECLARATIONS.clear();
  for (const [id, levels] of Object.entries(map ?? {})) {
    if (Array.isArray(levels) && levels.length) EFFORT_DECLARATIONS.set(id, levels);
  }
}
export function effortDeclarationsFor(model) {
  return EFFORT_DECLARATIONS.get(model) ?? null;
}

// ── Config-dimension write gate (add-agent-config-dims D5) ──────────────────
//
// The ONE shape gate for effort and context budget, shared by the fleet member
// PATCH, the fleet PATCH and the bot PATCH so all three refuse illegal values
// with a single voice (same discipline as the model chain: one rule, every
// door). Returns { error } or the normalized pair (null = clear the
// declaration). `effortUnion` is the set of levels ANY known model declares —
// validated against the union, not one model, because the effective model can
// change after the write.
export const CONTEXT_BUDGET_FLOOR = 1024;
export const CONTEXT_BUDGET_CEILING = 2_000_000;

export function validateConfigDims({ effort, contextBudget } = {}, effortUnion = new Set()) {
  const out = { effort: null, contextBudget: null };
  if (effort !== undefined) {
    if (effort === null || effort === "") {
      out.effort = null;
    } else if (typeof effort !== "string") {
      return { error: "effort must be a string or null" };
    } else if (!effortUnion.size) {
      return { error: "no model on this deployment declares thinking levels — effort cannot be set" };
    } else if (!effortUnion.has(effort)) {
      return { error: `effort '${effort}' is not a level any known model declares (choose one of: ${[...effortUnion].join(", ")})` };
    } else {
      out.effort = effort;
    }
  }
  if (contextBudget !== undefined) {
    if (contextBudget === null) {
      out.contextBudget = null;
    } else if (!Number.isInteger(contextBudget) || contextBudget < CONTEXT_BUDGET_FLOOR || contextBudget > CONTEXT_BUDGET_CEILING) {
      return { error: `contextBudget must be an integer between ${CONTEXT_BUDGET_FLOOR} and ${CONTEXT_BUDGET_CEILING}, or null` };
    } else {
      out.contextBudget = contextBudget;
    }
  }
  return out;
}

// Every level any known model declares, from a dshModels list (ctx.dshModels).
export function effortUnionFrom(models) {
  const set = new Set();
  for (const m of models ?? []) {
    for (const l of m?.reasoningEfforts ?? []) set.add(l);
  }
  return set;
}

// Budget overflow fallback (add-model-surface-budget-gate follow-up).
//
// The chain above is built from DECLARATIONS (member → fallback → fleet → cell)
// and never looks at remaining budget. So when every declared hop is over its
// daily/monthly limit the round dies with `budget_exhausted` — even if the
// runner has a model sitting at zero usage.
//
// Live 2026-11-10, the owner cell:
//   deepseek-v4.1-flash  daily  8,070,816 / 8,000,000   (exhausted)
//   glm-5.3-flash        daily    109,713 / 8,000,000   (1.4%)
//   deepseek-flash       daily          0 / 20,000,000  (untouched, not in any chain)
// Every optimizer round failed as `budget_exhausted` while an unused model was
// available to the same runner. That is the defect this function exists to
// remove: "no budget on the declared chain" should degrade to "use a model
// that has budget", not to "do not run".
//
// Rules:
//   - only consulted when EVERY declared candidate is blocked (the caller
//     decides that; this function just answers "what else has room?");
//   - a model with no verdict is NOT eligible — unknown is not empty, and
//     guessing would move a turn onto a model nobody vetted;
//   - excluded models (already tried and failed) never come back;
//   - the winner is the first eligible in roster order, so the choice is
//     stable across rounds rather than flickering.
export function pickBudgetFallback({ candidates = [], blocked = [], roster = null, probe = null } = {}) {
  if (typeof probe !== "function") return null;
  const tried = new Set((blocked ?? []).map((b) => b?.model).filter(Boolean));
  for (const c of candidates ?? []) {
    const model = typeof c === "string" ? c : c?.model;
    if (model) tried.add(model);
  }
  const pool = Array.isArray(roster) ? roster : [];
  for (const model of pool) {
    if (typeof model !== "string" || !model) continue;
    if (tried.has(model)) continue;
    let verdict = null;
    try {
      verdict = probe(model);
    } catch {
      continue; // a probe failure cannot make a model eligible
    }
    if (verdict && verdict.allowed === true) return model;
  }
  return null;
}
