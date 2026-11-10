// ── One deployed role's runtime child (add-a2a-agent-serving 4.2/4.4) ───────
//
// The manager-facing lifecycle shell for one runtime process: readiness,
// draining, active-turn counting, budget-kill marking, warm-zone timestamps.
// The PROTOCOL face — stdio JSON-RPC spawn/initialize, the notification pump,
// per-session collectors, the live delta lane, wire session namespacing and
// persona/model parking — lives in the harness adapter behind this shell
// (add-harness-adapter D2: agent-runner/harness/dsh.js is the dsh
// implementation; the shell itself is harness-neutral).
//
// `clientFactory` is injectable so unit tests drive a fake harness; the
// default factory is the real spawn (initialize retries the adapter-
// registration race exactly like DshBridge).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import { DshHarnessAdapter } from "./harness/dsh.js";

let nextNonce = 0;
export function sessionKeyFor(contextId) {
  // dsh session ids become filesystem paths inside DSH_HOME — keep them
  // boring. Deterministic per contextId so a conversation continues across
  // child restarts (resume-by-id) within the same home.
  const slug = String(contextId || `ephemeral-${Date.now()}-${nextNonce++}`)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `srv-${slug || "ctx"}`;
}

// The environment a spawned child may see (add-agent-notifications D2): the
// runner's own, minus every relay credential. The token's only owner is the
// runner's process configuration; the child reaches notifications exclusively
// through the bridge, executed host-side. Stripped here — where the spawn
// spec is BUILT — so the spec, not just the wire, is credential-free.
export function scrubbedChildEnv(env = process.env) {
  const out = { ...env };
  delete out.AGENT_RUNNER_RELAY_TOKEN;
  delete out.BOTS_RELAY_TOKEN;
  return out;
}

export class AgentChild {
  // `turnTimeoutMs` IS this child's effective turn budget (add-serving-budgets
  // D3: the descriptor's minutes, else the runner default); `budgetLabel` is
  // the human bound the over-budget error names ("20m").
  // `adapter` (add-harness-adapter): the harness adapter instance driving this
  // child's runtime — the default is the dsh adapter built from `spawnSpec` +
  // `clientFactory`, so every pre-existing call site keeps working unchanged.
  // `notifyHandler` (add-agent-notifications D1): the host-side executor for
  // this child's `botNotify/send` notifications — the manager supplies it with
  // the deployment's bound channel. Absent → the call is declined
  // not-configured, never silently dropped.
  // `podMembers` (add-dsh-pod-adapter): Map<agentKey, {presetId, provider,
  // model, turnTimeoutMs, budgetLabel}> — non-null marks a POD child hosting
  // several same-pack members in one process; turns then name their member and
  // run per-member budgets. `costFloorMb` is the warm-zone planning floor (a
  // pod counts once at the pod floor, not per member).
  constructor({ key, spawnSpec, turnTimeoutMs = 180_000, budgetLabel, clientFactory, log = console, notifyHandler, onExit = null, podMembers = null, costFloorMb = null, budgetCancelGraceMs = 10_000, adapter = null }) {
    this.key = key;
    this.spawnSpec = spawnSpec; // { dshBin, profile, patchPaths, cwd, env, provider, model, presetId }
    this.turnTimeoutMs = turnTimeoutMs;
    this.budgetLabel = budgetLabel ?? `${Math.max(1, Math.ceil(turnTimeoutMs / 60_000))}m`;
    this.log = log;
    this.podMembers = podMembers;
    this.costFloorMb = costFloorMb;
    this.version = spawnSpec.version ?? null;
    this.lastActivityAt = Date.now();
    this.spawnedAt = Date.now(); // warm-zone hysteresis anchor (manager)
    this.draining = false; // no NEW sessions/turns; in-flight ones finish
    // The harness adapter (dsh by default — a descriptor-declared harness
    // resolves to its own adapter at the spawn site, add-harness-adapter).
    // The dsh shape is constructed HERE from the classic arguments so every
    // pre-existing call site (manager solo/pod spawns, unit tests) is
    // byte-identical in behavior.
    this.adapter = adapter ?? new DshHarnessAdapter({
      key,
      spawnSpec,
      clientFactory,
      log,
      onNotify: notifyHandler ? (payload) => notifyHandler(payload) : null,
      onExit,
      podMembers,
      budgetCancelGraceMs,
      turnTimeoutMs,
      budgetLabel: this.budgetLabel,
    });
  }

  // ── Lifecycle/state surface the manager reads ──────────────────────────────

  get ready() {
    return this.adapter.ready === true;
  }

  get activeTurns() {
    return this.adapter.activeTurns ?? 0;
  }

  // Set when a turn settled by budget timeout (never reset: a killed child
  // is discarded — the manager removes it and the next touch re-spawns).
  get budgetKilled() {
    return this.adapter.budgetKilled === true;
  }

  // Best-effort process id for RSS sampling (the warm-zone budget).
  get pid() {
    return this.adapter.pid?.() ?? null;
  }

  get state() {
    if (this.draining) return "draining";
    return this.ready ? "serving" : "starting";
  }

  // Whether a session on this child has a turn in flight (the external-
  // context reap pass skips active sessions; add-wanxing-serving-api D10).
  // The adapter owns the wire-session bookkeeping, so the probe is delegated
  // (dsh: collector keys; other harnesses: their own session map).
  isActive(sessionKey) {
    return this.adapter.isActive?.(sessionKey) === true;
  }

  // Active turns for ONE member (pod health) — adapter-owned prefix scan.
  agentActiveTurns(agentKey) {
    return this.adapter.agentActiveTurns?.(agentKey) ?? this.activeTurns;
  }

  // The wire session id for one (member, session) pair — the dsh adapter's
  // namespace; other harnesses address sessions directly (their adapter
  // ignores agentKey). Exposed for tests and the reap's tail parsing.
  static wireSessionId(agentKey, sessionId) {
    return DshHarnessAdapter.wireSessionId(agentKey, sessionId);
  }

  async start() {
    if (this.ready) return;
    await this.adapter.start();
    return undefined;
  }

  // Run one turn through the adapter. Every exit path settles exactly once
  // (prompt rejection included), or the activeTurns counter leaks and a later
  // drain would wedge.
  async turn(sessionId, text, { onDelta, agentKey, onAsk, onEvent } = {}) {
    if (this.draining) {
      throw Object.assign(new Error("this agent is draining (upgrade or undeploy in progress)"), { code: -32000 });
    }
    this.lastActivityAt = Date.now();
    try {
      return await this.adapter.turn(sessionId, text, { onDelta, agentKey, onAsk, onEvent });
    } finally {
      this.lastActivityAt = Date.now();
    }
  }

  // The optional deep-control lane (dsh: the platform bridge's live methods).
  // A harness without one answers unsupportedCapability (adapter.js).
  async request(method, params) {
    return this.adapter.request(method, params);
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  get idle() {
    return this.activeTurns === 0 && Date.now() - this.lastActivityAt >= 0;
  }

  // Drain: reject new turns now; resolve when in-flight turns finish or the
  // timeout elapses (spec: five minutes), then stop the child.
  async drainAndStop(timeoutMs) {
    this.draining = true;
    const deadline = Date.now() + timeoutMs;
    while (this.activeTurns > 0 && Date.now() < deadline) {
      await sleep(500);
    }
    await this.stop();
  }

  async stop() {
    await this.adapter.stop();
  }
}
