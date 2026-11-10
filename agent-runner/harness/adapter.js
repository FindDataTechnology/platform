// ── HarnessAdapter contract (add-harness-adapter D1) ─────────────────────────
//
// The agent-level seam between the runner's manager and whatever AI harness
// process hosts a deployed agent: dsh today (DshHarnessAdapter), any
// ACP-speaking agent binary next (AcpHarnessAdapter). The manager owns
// composition (home materialization, credential pinning), scheduling
// (capacity, warm zone, budgets), and metering; an adapter owns exactly one
// runtime process and the turn protocol inside it.
//
// The contract is deliberately AGENT-LEVEL. Density tricks (multi-agent
// co-hosting), wire session namespacing, persona/model parking, and the
// platform bridge's live-control RPCs are dsh-implementation internals and
// MUST NOT appear in this interface — an ACP harness is one-process-per-
// conversation by nature, and leaking those concepts would make the
// interface unimplementable for it. The one concession is `agentKey` on
// `turn()`: a co-hosting implementation may use it, every other
// implementation ignores it.
//
// Capability reporting is a map, not a promise: callers degrade OPEN on
// absence (missing key = unknown, not unsupported), and a control call
// against an explicitly-unsupported capability fails with a structured error
// naming it — never a silent no-op, never a crash.

/** Capability keys an adapter may report. Values: true (supported) / false (explicitly not). */
export const ADAPTER_CAPABILITIES = Object.freeze([
  // Live model switching on an existing session (dsh: model/set; ACP: session/set_config_option).
  "liveModel",
  // Native turn cancellation (dsh: session/cancel; ACP: session/cancel notification).
  "cancel",
  // Incremental text deltas during a turn (dsh: platform/stream frames; ACP: session/update chunks).
  "stream",
  // Per-session persona selection (dsh bridge preset parking; no ACP equivalent).
  "perSessionPreset",
  // Multi-agent co-hosting in one process (dsh pod mode; never for ACP harnesses).
  "cohost",
  // In-flight asks forwarded to the turn's caller (dsh: the serving questions
  // bridge's userQuestion/ask + userQuestions/answer; ACP children never
  // compose the ask overlay, so they report false — add-serving-ask-bridge).
  "asks",
]);

// Optional per-turn event callback (fix-memory-capture-p0 D2): `onEvent` in
// turn() options receives `{type:"tool_call"|..., callId, toolName, ...}` for
// tool activity the harness observes mid-turn. NOT a capability key — adapters
// that don't surface it simply never call it, and the manager's observation
// degrades to turn-boundary events only (never a turn failure).

/**
 * The structured error for a control call against an unsupported capability.
 * Codes live in the same family the runner already meters on: a control
 * failure is a failed call, not a failed turn.
 */
export function unsupportedCapability(adapterName, capability) {
  return Object.assign(
    new Error(`harness adapter '${adapterName}' does not support capability '${capability}'`),
    { code: -32006, capability },
  );
}

// The cold-start failure family: a runtime that could not come up. Distinct
// from turn errors so the manager's respawn escalation and the meter can tell
// "this agent never started" from "this turn failed" (the -32004 family the
// dsh path already uses).
export function coldStartFailure(adapterName, cause) {
  return Object.assign(
    new Error(`harness adapter '${adapterName}' failed to start its runtime (${cause?.message || cause})`),
    { code: -32004, cause },
  );
}

/**
 * Runtime shape check — a new adapter fails loudly at construction instead of
 * halfway through the first turn. Checks presence only (behavior is the
 * contract suite's job); `request` is the optional deep-control lane and may
 * be absent (callers then get unsupportedCapability on every call).
 */
export function assertAdapter(adapter, { name = adapter?.name ?? "unknown" } = {}) {
  const required = ["start", "turn", "stop", "pid", "capabilities"];
  for (const method of required) {
    if (typeof adapter?.[method] !== "function") {
      throw new TypeError(`harness adapter '${name}' is missing required method '${method}' (see agent-runner/harness/adapter.js)`);
    }
  }
  const caps = adapter.capabilities();
  if (caps === null || typeof caps !== "object" || Array.isArray(caps)) {
    throw new TypeError(`harness adapter '${name}' capabilities() must return an object map (got ${JSON.stringify(caps)})`);
  }
  for (const key of Object.keys(caps)) {
    if (!ADAPTER_CAPABILITIES.includes(key)) {
      throw new TypeError(`harness adapter '${name}' reports unknown capability '${key}' (known: ${ADAPTER_CAPABILITIES.join(", ")})`);
    }
  }
  return adapter;
}

/**
 * The optional deep-control lane, resolved uniformly: an adapter without a
 * `request` method answers every call with unsupportedCapability — the caller
 * never branches on adapter identity.
 */
export async function adapterRequest(adapter, method, params) {
  if (typeof adapter?.request !== "function") {
    throw unsupportedCapability(adapter?.name ?? "unknown", method);
  }
  return adapter.request(method, params);
}
