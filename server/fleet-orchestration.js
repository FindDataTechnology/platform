// Fleet orchestration algebra, wave 1 (agent-fleet-orchestration).
//
// The declarative edge grammar: a fleet MAY carry an `orchestration` section
// { mode?, edges?, constraints? }. Edges are DATA — trigger edges are the graph
// shape of the cadence materialization that already exists and change NOTHING
// at runtime; report edges are DERIVED from the org tree (see expandedEdges);
// only dispatch (the dispatch_post tool's permission), handoff (the completion
// hook at the turn seam), fanout (the parallel wave) and event (the bot wake)
// carry behavior. Validation is a pure function over
// {members, orchestration} — no IO, injectable everywhere, the single
// authority both the write face and the runtime helpers read.
//
// Wave 1 is a DAG: handoff cycles (bounded rounds) belong to wave 2's fanout.

export const EDGE_KINDS = ["trigger", "report", "dispatch", "handoff", "fanout", "event"];
export const FANOUT_ROUNDS_MAX = 3;
export const EVENT_SOURCE_RE = /^bot:[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MODES = ["schedule", "supervisor", "pipeline"];

export const DEFAULT_MAX_CHAIN_DEPTH = 8;
export const DEFAULT_SPAN_MAX = 8;
export const DEFAULT_BUDGET_PER_EDGE_MIN = 10;

// Whole-run budget (add-fleet-run-budget D1). Per-edge timeouts bound ONE hop;
// nothing bounded a chain. Absent/null = unlimited, so every fleet that never
// declares it behaves exactly as before. Three independent ceilings, each
// optional:
//   maxTurns   — hops this run may start (finished turns + in-flight count)
//   maxTokens  — reported input+output tokens summed over the run
//   maxMinutes — wall clock from the run header's start
const budgetCeiling = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

export function normalizeRunBudget(raw) {
  if (raw == null) return { maxTurns: null, maxTokens: null, maxMinutes: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { maxTurns: null, maxTokens: null, maxMinutes: null };
  return {
    maxTurns: budgetCeiling(Number(raw.maxTurns)),
    maxTokens: budgetCeiling(Number(raw.maxTokens)),
    maxMinutes: budgetCeiling(Number(raw.maxMinutes)),
  };
}

export function runBudgetDeclared(budget) {
  return !!(budget && (budget.maxTurns != null || budget.maxTokens != null || budget.maxMinutes != null));
}

function num(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Normalize constraints with defaults filled.
export const CARRIERS = ["auto", "cell", "worker", "runner"];
export function constraintsOf(orchestration) {
  const c = orchestration?.constraints ?? {};
  return {
    maxChainDepth: num(c.maxChainDepth, DEFAULT_MAX_CHAIN_DEPTH),
    spanMax: num(c.spanMax, DEFAULT_SPAN_MAX),
    budgetPerEdgeMin: num(c.budgetPerEdgeMin, DEFAULT_BUDGET_PER_EDGE_MIN),
    runBudget: normalizeRunBudget(c.runBudget),
    // Turn carrier (add-fleet-carrier): the fleet-level default placement —
    // null = unset (resolution falls through to the deployment default/auto).
    carrier: CARRIERS.includes(c.carrier) ? c.carrier : null,
  };
}

// Mode expansion is READ-TIME (design D2): supervisor adds an all→all
// dispatch permission; schedule/pipeline add nothing implicit (pipeline
// chains must be declared — grill Q3). Never stored expanded.
//
// Report edges are DERIVED from the org tree (fix-report-edge): the reporting
// topology the platform actually runs on is `member.parentId`, and a second,
// independently declared copy of that fact can only drift from it. So the graph
// always shows one report edge per parent→child pair, read-time only — and
// validateOrchestration refuses a DECLARED report edge that contradicts the
// tree (a truthful one is accepted and not duplicated).
export function expandedEdges({ members = [], orchestration = {} } = {}) {
  // A fleet without an orchestration section still has an org tree, so the
  // derivation below must work for null too (the two route callers happen to
  // gate on it, but the function should not depend on that).
  const orch = orchestration ?? {};
  const declared = Array.isArray(orch.edges) ? orch.edges : [];
  const edges = declared.map((e) => ({ ...e }));
  for (const m of members) {
    if (!m?.parentId || !m?.id) continue;
    // `from` reports upward to `to` (the UI renders "from ↑ 报数上行"), so the
    // child is the reporter and the parent is the receiver.
    const already = edges.some((e) => e.kind === "report" && e.from === m.id && e.to === m.parentId);
    if (!already) edges.push({ kind: "report", from: m.id, to: m.parentId, derived: true });
  }
  if (orch.mode === "supervisor") {
    const refs = members.map((m) => m.id);
    for (const from of refs) {
      for (const to of refs) {
        if (from === to) continue;
        if (!edges.some((e) => e.kind === "dispatch" && e.from === from && e.to === to)) {
          edges.push({ kind: "dispatch", from, to, implicit: true });
        }
      }
    }
  }
  return edges;
}

// Full write-face validation. Returns { ok, errors, warnings, edges }.
export function validateOrchestration({ members = [], orchestration = null } = {}) {
  const errors = [];
  const warnings = [];
  if (orchestration == null) return { ok: true, errors, warnings, edges: [] };
  if (typeof orchestration !== "object" || Array.isArray(orchestration)) {
    return { ok: false, errors: [{ error: "orchestration must be an object or null" }], warnings, edges: [] };
  }
  const constraints = constraintsOf(orchestration);
  if (orchestration.mode != null && !MODES.includes(orchestration.mode)) {
    errors.push({ error: `mode must be one of ${MODES.join("|")}` });
  }
  for (const [key, value] of Object.entries(orchestration.constraints ?? {})) {
    // Non-numeric constraints have their own shape gates below — the numeric
    // rule must not swallow them (carrier is a string; runBudget an object).
    if (key === "carrier" || key === "runBudget") continue;
    if (!Number.isFinite(value) || value <= 0) {
      errors.push({ error: `constraints.${key} must be a positive number` });
    }
  }
  // Whole-run budget (add-fleet-run-budget D1): an object of optional positive
  // integers. A declared-but-empty object is refused rather than silently
  // meaning "no budget" — a fleet that typed runBudget expects a ceiling.
  const rawBudget = orchestration.constraints?.runBudget;
  if (rawBudget != null) {
    if (typeof rawBudget !== "object" || Array.isArray(rawBudget)) {
      errors.push({ error: "constraints.runBudget must be an object" });
    } else {
      const allowed = new Set(["maxTurns", "maxTokens", "maxMinutes"]);
      for (const [k, v] of Object.entries(rawBudget)) {
        if (!allowed.has(k)) {
          errors.push({ error: `constraints.runBudget.${k} is not a run-budget dimension (${[...allowed].join("|")})` });
        } else if (!Number.isFinite(Number(v)) || Number(v) <= 0) {
          errors.push({ error: `constraints.runBudget.${k} must be a positive number` });
        }
      }
      if (!runBudgetDeclared(normalizeRunBudget(rawBudget))) {
        errors.push({ error: "constraints.runBudget declares no ceiling — omit it or set maxTurns/maxTokens/maxMinutes" });
      }
    }
  }
  if (orchestration.constraints?.maxChainDepth > 32) {
    errors.push({ error: "constraints.maxChainDepth must not exceed 32" });
  }
  if (orchestration.constraints?.carrier != null && !CARRIERS.includes(orchestration.constraints.carrier)) {
    errors.push({ error: `constraints.carrier must be one of ${CARRIERS.join("|")}` });
  }

  const known = new Set(members.map((m) => m.id));
  const raw = Array.isArray(orchestration.edges) ? orchestration.edges : null;
  if (orchestration.edges != null && raw == null) {
    errors.push({ error: "edges must be an array" });
  }
  const outDegree = new Map();
  for (const [i, e] of (raw ?? []).entries()) {
    const at = `edges[${i}]`;
    if (!e || typeof e !== "object") {
      errors.push({ error: `${at} must be an object`, entry: at });
      continue;
    }
    if (!EDGE_KINDS.includes(e.kind)) {
      errors.push({ error: `${at}.kind must be one of ${EDGE_KINDS.join("|")}`, entry: at });
      continue;
    }
    for (const ref of ["from", "to"]) {
      if (ref === "from" && e.kind === "trigger") continue; // trigger edges hang off the cron, not a post
      if (ref === "from" && e.kind === "event") continue; // event sources are external (bot:<id>) — shape-checked below
      if (ref === "to" && e.kind === "fanout") continue; // fanout addresses `targets`, not `to`
      if (typeof e[ref] !== "string" || !known.has(e[ref])) {
        errors.push({ error: `${at}.${ref} '${e[ref]}' does not match a member of this fleet`, entry: at });
        continue;
      }
      // 审计官不进工作图（2026-11-10）。它审的是「判断」，编导边搬的是「活」。
      // 把它放进边里，它就成了自己参与的那条工作流的一部分——审自己参与的活，
      // 是利益冲突，也是它唯一不该有的处境。所以 handoff/dispatch/fanout 的
      // 两端、event 的目标、fanout 的裁判，一律不收 auditor。
      //
      // 这条以前是靠「它不是 persona 也不是 a2a」被顺带拦下的，报错却说
      // 「cluster has no manual lane / tool posts take per-hop args」——不会有人
      // 从中读出「审计官不能派活」。
      const member = members.find((m) => m.id === e[ref]);
      if (member?.targetKind === "auditor") {
        errors.push({
          error: `${at}.${ref} '${e[ref]}' is an auditor post — 审计官不进工作图：它复核判断，不接活也不派活（否则它就在审自己参与的活）。审计官的结论通过拍板车道回到主人，不经编导边`,
          code: "auditor_not_orchestratable",
          entry: at,
        });
      }
    }
    if (e.kind === "report") {
      // Report edges are DERIVED from parentId (fix-report-edge): `from` is the
      // reporting post, `to` the post it reports to, and the tree says the same
      // thing through `from.parentId`. Declaring one is allowed only when it
      // states that truth, so a fleet that spelled the tree out keeps working
      // while a declaration that CONTRADICTS the tree is refused — a graph edge
      // that lies is worse than no edge. expandedEdges dedupes, so a truthful
      // declaration is not shown twice.
      const reporter = members.find((m) => m.id === e.from);
      if (reporter && reporter.parentId !== e.to) {
        errors.push({
          error: `${at}: a report edge must follow the org tree — '${e.from}' reports to '${reporter.parentId ?? "(nobody)"}', not '${e.to}' (report edges are derived from parentId; drop the declaration or move the post)`,
          entry: at,
        });
      }
    }
    if (e.kind === "event") {
      // Event edges (add-fleet-event-wake): an external signal source wakes
      // a post. Existence of the bot is judged at run time honestly (the
      // registry is runtime state); the SHAPE is pinned here.
      if (typeof e.from !== "string" || !EVENT_SOURCE_RE.test(e.from)) {
        errors.push({ error: `${at}.from must be an external source name like 'bot:<botId>'`, entry: at });
      }
      const target = members.find((m) => m.id === e.to);
      // persona-only: 事件边目标；auditor 已在上面被显式拒绝（code=auditor_not_orchestratable）
      if (target && target.targetKind !== "persona" && target.targetKind !== "a2a") {
        errors.push({ error: `${at}.to must be a persona/a2a post — cluster has no manual lane and tool posts take per-hop args`, entry: at });
      }
    }
    if (e.kind === "handoff" && e.from === e.to) {
      errors.push({ error: `${at}: a post cannot hand off to itself`, entry: at });
    }
    if (e.kind === "dispatch" && e.from === e.to) {
      errors.push({ error: `${at}: a post cannot dispatch to itself`, entry: at });
    }
    if (e.kind === "fanout") {
      // Fanout shape (add-fleet-fanout D1): ≥2 distinct targets, no self,
      // no tool targets (their arguments are per-hop — handoff+args is that
      // lane), judge rules, rounds bound. Fanout edges stay OUT of the DAG
      // walk: their loops are rounds-bounded waves, depth stays the global
      // anti-runaway bound.
      const targets = e.targets;
      if (!Array.isArray(targets) || targets.length < 2) {
        errors.push({ error: `${at}.targets must list at least 2 posts`, entry: at });
      } else {
        if (new Set(targets).size !== targets.length) {
          errors.push({ error: `${at}.targets has duplicates`, entry: at });
        }
        for (const t of targets) {
          if (typeof t !== "string" || !known.has(t)) {
            errors.push({ error: `${at}.targets '${t}' does not match a member of this fleet`, entry: at });
          } else if (t === e.from) {
            errors.push({ error: `${at}: a post cannot fan out to itself`, entry: at });
          } else if (members.find((m) => m.id === t)?.targetKind === "tool") {
            errors.push({ error: `${at}.targets '${t}' is a tool post — tool hops take a handoff edge with per-hop args`, entry: at });
          } else if (members.find((m) => m.id === t)?.targetKind === "auditor") {
            errors.push({
              error: `${at}.targets '${t}' is an auditor post — 审计官不进工作图：它复核判断，不接活（fanout 是分派，不是复核）`,
              code: "auditor_not_orchestratable",
              entry: at,
            });
          }
        }
      }
      const agg = e.aggregate ?? { kind: "all" };
      if (!["first", "all", "judge"].includes(agg.kind)) {
        errors.push({ error: `${at}.aggregate.kind must be one of first|all|judge`, entry: at });
      }
      if (agg.kind === "judge") {
        if (typeof agg.judge !== "string" || !known.has(agg.judge)) {
          errors.push({ error: `${at}.aggregate.judge must reference a member of this fleet`, entry: at });
        } else {
          if (agg.judge === e.from) errors.push({ error: `${at}.aggregate.judge cannot be the fanning post itself`, entry: at });
          if (Array.isArray(targets) && targets.includes(agg.judge)) {
            errors.push({ error: `${at}.aggregate.judge cannot also be a target`, entry: at });
          }
          // The judge turn is a LOCAL persona turn (the aggregator switches
          // back to its roster preset) — an a2a judge has none.
          const judgeMember = members.find((m) => m.id === agg.judge);
          if (judgeMember?.targetKind === "auditor") {
            errors.push({
              error: `${at}.aggregate.judge '${agg.judge}' is an auditor post — 审计官不进工作图（裁判要出结论，审计官只出异议）`,
              code: "auditor_not_orchestratable",
              entry: at,
            });
          } else if (judgeMember?.targetKind !== "persona") { // persona-only: auditor 已在上面的分支被拒
            errors.push({ error: `${at}.aggregate.judge must be a persona post (the judge turn runs locally)`, entry: at });
          }
        }
      }
      if (e.rounds !== undefined && (!Number.isInteger(e.rounds) || e.rounds < 1 || e.rounds > FANOUT_ROUNDS_MAX)) {
        errors.push({ error: `${at}.rounds must be an integer 1..${FANOUT_ROUNDS_MAX} (declarative bound; depth stays the hard bound)`, entry: at });
      }
      if (e.args !== undefined) {
        errors.push({ error: `${at}: fanout edges take no args — per-target arguments are the handoff lane`, entry: at });
      }
    }
    // Tool-hop arguments (add-tool-posts): a handoff edge into a tool post
    // carries its JSON args (object); anything else fails at run time, so the
    // shape is pinned here.
    if (e.args !== undefined && (typeof e.args !== "object" || e.args === null || Array.isArray(e.args))) {
      errors.push({ error: `${at}.args must be a JSON object (tool-hop arguments)`, entry: at });
    }
    if (typeof e.from === "string" && e.kind !== "trigger") {
      outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + (e.kind === "fanout" && Array.isArray(e.targets) ? e.targets.length : 1));
    }
  }

  // DAG check over handoff edges only (wave 1), plus chain-length bound.
  const handoffs = (raw ?? []).filter((e) => e && e.kind === "handoff" && typeof e.from === "string" && typeof e.to === "string");
  const next = new Map();
  for (const e of handoffs) {
    if (!next.has(e.from)) next.set(e.from, []);
    next.get(e.from).push(e.to);
  }
  const depthCache = new Map();
  const chainDepth = (node, seen = new Set()) => {
    if (depthCache.has(node)) return depthCache.get(node);
    if (seen.has(node)) return Infinity; // cycle — flagged separately below
    seen.add(node);
    let d = 0;
    for (const t of next.get(node) ?? []) d = Math.max(d, 1 + chainDepth(t, seen));
    seen.delete(node);
    depthCache.set(node, d);
    return d;
  };
  for (const e of handoffs) {
    const seen = new Set();
    const walk = (n) => {
      if (seen.has(n)) return [n];
      seen.add(n);
      for (const t of next.get(n) ?? []) {
        const cyc = walk(t);
        if (cyc) return cyc;
      }
      return null;
    };
    const cyc = walk(e.from);
    if (cyc) {
      errors.push({ error: `handoff edges cycle through post '${cyc[cyc.length - 1]}'`, entry: `edges ${e.from}→${e.to}` });
      break;
    }
    const d = chainDepth(e.from);
    if (!Number.isFinite(d)) continue;
    if (d > constraints.maxChainDepth) {
      errors.push({ error: `handoff chain from '${e.from}' is ${d} hops — over maxChainDepth ${constraints.maxChainDepth}`, entry: `edges ${e.from}→${e.to}` });
    }
  }
  for (const [from, deg] of outDegree) {
    if (deg > constraints.spanMax) {
      warnings.push(`post '${from}' has ${deg} outgoing edges — over the span-${constraints.spanMax} advisory; prefer layering`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, edges: expandedEdges({ members, orchestration }) };
}

// May `from` dispatch to `to` right now? Three grant sources: an explicit
// dispatch edge, supervisor mode's implicit all→all permission, or a declared
// handoff edge between the pair (fix-fleet-chain-operability D1) — forward
// (from→to) is the handoff itself, backward (to→from) is the return channel
// (a reviewer handing blocked drafts back to the modeler). The pack publish
// gate forbids declaring handoff cycles, so a "declare the reverse edge"
// escape hatch structurally cannot exist for pipelines; one declared
// collaboration edge therefore carries both directions between exactly its
// two endpoints. Read-time only — nothing lands as an implicit stored edge,
// and the grant never extends beyond the declared pair. Same-fleet is
// structural (both refs come from one fleet's member set).
export function dispatchAllowed({ orchestration = null } = {}, from, to) {
  if (from === to) return { ok: false, error: "a post cannot dispatch to itself" };
  if (orchestration?.mode === "supervisor") return { ok: true };
  const edges = Array.isArray(orchestration?.edges) ? orchestration.edges : [];
  const hit = edges.some(
    (e) =>
      (e?.kind === "dispatch" && e.from === from && e.to === to) ||
      (e?.kind === "handoff" &&
        ((e.from === from && e.to === to) || (e.from === to && e.to === from))),
  );
  return hit
    ? { ok: true }
    : { ok: false, error: "no dispatch edge, supervisor mode, or declared handoff pair grants this pair — declare the edge to allow it" };
}

// The handoff edges leaving a post (runtime helper for the turn seam).
export function outgoingHandoffs(orchestration, memberId) {
  const edges = Array.isArray(orchestration?.edges) ? orchestration.edges : [];
  return edges.filter((e) => e?.kind === "handoff" && e.from === memberId);
}

// The fanout edges leaving a post (runtime helper for the turn seam).
export function outgoingFanouts(orchestration, memberId) {
  const edges = Array.isArray(orchestration?.edges) ? orchestration.edges : [];
  return edges.filter((e) => e?.kind === "fanout" && e.from === memberId);
}
