// Turn contract (agent-turn-contract, add-turn-contract).
//
// The explicit description of ONE turn — the single derivation every consumer
// (O1 turn events today; O3 dispatch and O4 edge ignition tomorrow) reads
// from. Pure: from a task-engine record to a value object, no IO, no
// construction, no execution. The CONSTRUCT direction (peer/event sources,
// caller sinks born from dispatch) belongs to later changes and is refused
// here by name — reserved values fail structurally with their destination
// stated, so the enum can never silently grow.
//
// Field mapping is facts-only (design D2): every value below already exists
// somewhere in the engine record or the bridges — this module just names it.

export const SOURCES = ["cron", "manual", "delegation", "event"];
export const RESERVED_SOURCES = {
  peer: "fleet dispatch (O3) — the dispatch lane is not built yet",
};
export const RESULT_SINKS = ["report", "caller"];
export const RESERVED_RESULT_SINKS = {
  blackboard: "the shared blackboard (O5) — not built yet",
};
// Depth bounds are per-lane (add-fleet-orchestration): the dispatch lane
// (ad-hoc, run-time) is hard-bounded at 1; the handoff lane (declared,
// graph-validated chains) is bounded by the fleet's declared maxChainDepth.
export const DISPATCH_DEPTH_BOUND = 1;
export const DEFAULT_MAX_CHAIN_DEPTH = 8;
// Chain edge kinds (agent-fleet-runs): how a downstream turn was ignited.
// Stamped by the igniting side on the task's origin.fleet.chain; read here.
export const EDGE_KINDS = ["dispatch", "handoff", "fanout"];

// Engine trigger kinds (task-engine.js): "schedule" = cron-armed, "manual" =
// bridge-created. A scheduled task is cron-sourced with or without a fleet
// sourceTag; a manual fleet task (run-now / execute-now) reads manual.
export function buildTurnRequest(job) {
  const sourceTag = job?.sourceTag ?? null;
  const origin = job?.origin ?? null;
  const initiator = job?.initiator ?? null;
  const event = origin?.event ?? null;
  // Chain position (agent-fleet-runs): the igniting side stamps
  // origin.fleet.chain = { runId, parentTurnId, edgeKind } on a dispatched /
  // handed-off / fanned-out task; a root turn carries none. Read-only by
  // contract — this derivation never mints an id (the run ledger does, at the
  // root turn's start), so deriving twice yields the same value object.
  const rawChain = origin?.fleet?.chain ?? null;
  const chain =
    rawChain && typeof rawChain.runId === "string" && rawChain.runId
      ? {
          runId: rawChain.runId,
          parentTurnId: typeof rawChain.parentTurnId === "string" ? rawChain.parentTurnId : null,
          edgeKind: EDGE_KINDS.includes(rawChain.edgeKind) ? rawChain.edgeKind : null,
        }
      : null;
  // Event wakes (add-fleet-event-wake) outrank everything: an external
  // signal source (bot inbound) originated the turn, depth 0 by definition.
  // (§15.115挂账班真缺陷：切片⑤给 origin.fleet 任务统一派生 sourceTag 后，旧序
  // 的 `sourceTag → cron` 把事件唤醒、派发、execute-now 全部误标 cron。终序按
  // 证据强弱：event 外部信号 > initiator 派发 > schedule 触发 > 裸 sourceTag
  // （cron 物化残留——⑤后有 origin.fleet 的任务必带 sourceTag，排除之）> manual。)
  // Initiator then outranks origin: a dispatched turn carries BOTH (the
  // target's origin.fleet evidence and the dispatcher's session) and IS a
  // delegation wake; origin.fleet alone (no initiating conversation) is the
  // execute-now lane. Found live on prod (§15.18): the old order mislabeled
  // dispatches.
  const source =
    event?.botId
      ? "event"
      : initiator
        ? "delegation"
        : job?.trigger === "schedule" || (sourceTag?.fleetId && !origin?.fleet)
          ? "cron"
          : "manual";
  return {
    source,
    targetRef: { kind: job?.targetType ?? "persona", id: job?.preset ?? null },
    brief: job?.prompt ?? null,
    evidence: {
      ...(sourceTag ? { sourceTag } : {}),
      ...(origin ? { origin } : {}),
      ...(initiator ? { initiator } : {}),
      ...(event ? { event } : {}),
    },
    // The delegation aggregator delivering a summary back into the initiating
    // conversation is an existing fact — this names it, it does not add it.
    resultSink: initiator ? "caller" : "report",
    // Outbound a2a turns carry depth 1 today (a2a-client's
    // X-Delegation-Depth baseline); dispatch/handoff tasks stamp their chain
    // position in origin.fleet.depth (absent = 0, byte-identical to before);
    // event wakes are external-origin by definition — depth 0.
    depth: event?.botId ? 0 : job?.origin?.fleet?.depth ?? (job?.targetType === "a2a" ? 1 : 0),
    budget: Number.isFinite(job?.executionPolicy?.timeoutMinutes)
      ? { minutes: job.executionPolicy.timeoutMinutes }
      : null,
    chain,
  };
}

// Structural gate for the future CONSTRUCT direction (and for tests): legal
// values pass silently (null); reserved values and out-of-bound depth fail
// with the reservation's destination named. Returns { error } or null.
// Depth is per-lane: dispatch-bounded at 1 unless a declared chain bound
// (`maxChainDepth`, validated at the fleet's orchestration write face) is
// supplied for the handoff lane.
export function assertTurnRequest(request, { maxChainDepth = null } = {}) {
  if (!request || typeof request !== "object") {
    return { error: "turnRequest must be an object" };
  }
  if (Object.hasOwn(RESERVED_SOURCES, request.source)) {
    return { error: `source '${request.source}' is reserved for ${RESERVED_SOURCES[request.source]}` };
  }
  if (!SOURCES.includes(request.source)) {
    return { error: `source must be one of ${SOURCES.join("|")}` };
  }
  if (Object.hasOwn(RESERVED_RESULT_SINKS, request.resultSink)) {
    return { error: `resultSink '${request.resultSink}' is reserved for ${RESERVED_RESULT_SINKS[request.resultSink]}` };
  }
  if (!RESULT_SINKS.includes(request.resultSink)) {
    return { error: `resultSink must be one of ${RESULT_SINKS.join("|")}` };
  }
  const bound = Number.isFinite(maxChainDepth) && maxChainDepth >= DISPATCH_DEPTH_BOUND
    ? maxChainDepth
    : DISPATCH_DEPTH_BOUND;
  if (!Number.isFinite(request.depth) || request.depth < 0 || request.depth > bound) {
    return {
      error: `depth must be within 0..1 (dispatch lane bound) or the declared chain bound (${bound}) — the anti-chain-amplification gate`,
    };
  }
  return null;
}
