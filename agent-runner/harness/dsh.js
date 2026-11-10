// ── DshHarnessAdapter (add-harness-adapter D2) ───────────────────────────────
//
// The dsh implementation of the harness adapter contract (adapter.js). This is
// the protocol face of the pre-existing AgentChild, moved here verbatim so the
// second harness has a seam to plug into: the stdio JSON-RPC client lifecycle
// (spawn → initialize with adapter-registration retry → notification pump),
// the per-session collector turn pattern (settle on session.status idle), the
// live delta lane (platform/stream frames, restore-assistant-stream-020), the
// wire session namespace and persona/model parking of pod mode
// (add-dsh-pod-adapter), and the turn error family (-32001 budget, -32002
// child exit, -32003 self-reported LLM failure, -32005 empty turn).
//
// Everything here is dsh-specific depth and stays inside this file: the
// manager never sees collectors, wire ids, parking, or the pump.

import { unsupportedCapability } from "./adapter.js";
import { parseToolResult } from "../../lib/dsh-tool-result.js";

const INIT_RETRIES = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One dsh session.event (tool/call | tool/result) → the adapter's normalized
// memory-event shape (fix-memory-capture-p0 D2). Exported so the collector
// tests exercise the exact mapping the turn path uses. `toolNames` is the
// turn-local callId→name map (dsh's result event carries no tool name).
// Returns null for non-tool events.
export function dshToolEvent(ev, toolNames) {
  if (ev?.type === "tool/call") {
    const callId = ev.data?.callId;
    const name = ev.data?.name;
    if (callId && name && toolNames) toolNames.set(callId, name);
    return {
      type: "tool_call",
      callId: callId ?? null,
      toolName: name ?? null,
      args: ev.data?.arguments ?? null,
    };
  }
  if (ev?.type === "tool/result") {
    const parsed = parseToolResult(ev);
    return {
      type: "tool_result",
      callId: parsed.callId ?? null,
      toolName: (toolNames?.get(parsed.callId)) ?? null,
      resultText: parsed.resultText ?? "",
      isError: parsed.isError,
    };
  }
  return null;
}

export class DshHarnessAdapter {
  #collectors = new Map(); // wire session id → turn collector
  // Pod members whose sessions were prepared on THIS runtime (add-dsh-pod-adapter):
  // preset/set + model/set parked before the session's first prompt. A rebuilt
  // runtime starts empty and re-parks on first touch — which is exactly what a
  // resumed persisted session needs (the bridge resolves the parked preset on
  // the resume path too, so composition cannot drift across rebuilds).
  #prepared = new Set();
  // Solo model hot-swap state (add-model-session-boundary): the single-member
  // model face, null until the manager's first updateMemberModel lands —
  // before that, solo sessions compose the process-level model with NO
  // parking, the byte-identical legacy path. #soloSessions records every
  // session id this adapter has dispatched; at each update the snapshot
  // becomes #soloLegacy — the sessions that keep their model (the boundary:
  // only sessions first seen after the update compose the new one).
  #soloFace = null;
  #soloSessions = new Set();
  #soloLegacy = new Set();
  #ready = false;
  #budgetKilled = false;
  #activeTurns = 0;

  // `podMembers` (add-dsh-pod-adapter): Map<agentKey, {presetId, provider,
  // model, turnTimeoutMs, budgetLabel}> — non-null marks a POD runtime hosting
  // several same-pack members in one process; turns then name their member and
  // run per-member budgets.
  // `onNotify` (add-agent-notifications D1): the host-side executor for this
  // runtime's `botNotify/send` notifications — the manager supplies it with
  // the deployment's bound channel. Absent → the call is declined
  // not-configured, never silently dropped.
  // `onMatter` (add-matter-threads D3): the host-side executor for this
  // runtime's `matterCall/send` notifications — the manager wires it ONLY for
  // facade descriptors, with the deployment identity baked in. Absent → the
  // call is declined not-configured, never silently dropped.
  constructor({ key, spawnSpec, clientFactory, log = console, onNotify = null, onMatter = null, onExit = null, podMembers = null, budgetCancelGraceMs = 10_000, turnTimeoutMs = 180_000, budgetLabel = null, askGraceMs = Number(process.env.SERVING_ASK_GRACE_MS) || 20_000, initRetries = INIT_RETRIES }) {
    this.name = "dsh";
    this.key = key;
    this.spawnSpec = spawnSpec; // { profile, patchPaths, cwd, env, provider, model, presetId, version }
    this.clientFactory = clientFactory;
    this.log = log;
    this.onNotify = onNotify;
    this.onMatter = onMatter;
    this.onExit = onExit;
    this.podMembers = podMembers;
    this.budgetCancelGraceMs = budgetCancelGraceMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.askGraceMs = askGraceMs;
    this.budgetLabel = budgetLabel ?? `${Math.max(1, Math.ceil(turnTimeoutMs / 60_000))}m`;
    this.initRetries = initRetries;
    this.client = null;
    this.subscription = null;
  }

  capabilities() {
    return { liveModel: true, cancel: true, stream: true, perSessionPreset: true, cohost: true, asks: true };
  }

  get ready() {
    return this.#ready;
  }

  get activeTurns() {
    return this.#activeTurns;
  }

  // Set when a turn settles by budget timeout (never reset: a killed runtime
  // is discarded — the manager removes it and the next touch re-spawns).
  get budgetKilled() {
    return this.#budgetKilled;
  }

  // Best-effort process id for RSS sampling (the warm-zone budget). The
  // harness client owns the spawn; whatever shape it exposes is accepted,
  // null means "use the fixed per-agent cost instead".
  pid() {
    return this.client?.pid?.() ?? this.client?.pid ?? this.client?.proc?.pid ?? this.client?.child?.pid ?? null;
  }

  // Whether a wire session on this runtime has a turn in flight (the external-
  // context reap pass skips active sessions; add-wanxing-serving-api D10).
  isActive(wireSessionId) {
    return this.#collectors.has(wireSessionId);
  }

  // Session-boundary model hot-swap (add-model-session-boundary): the
  // manager's reconcile lands a descriptor model change here instead of
  // draining the child. This touches ONLY the parked model face — pod: the
  // member's row; solo: the single-member face — never #prepared (sessions
  // already parked keep their model to the end) and never an in-flight
  // collector (no running turn is disturbed). New sessions compose the new
  // model at their lazy creation; in-flight and already-parked sessions keep
  // the old one — the session-boundary semantic, no restart channel.
  // Invalid input is rejected loudly: an unknown member, or a non-string
  // provider/model, would otherwise silently park a broken face.
  updateMemberModel(agentKey, { provider, model } = {}) {
    if (typeof provider !== "string" || !provider) {
      throw new TypeError(`updateMemberModel: provider must be a non-empty string (got ${JSON.stringify(provider)})`);
    }
    if (typeof model !== "string" || !model) {
      throw new TypeError(`updateMemberModel: model must be a non-empty string (got ${JSON.stringify(model)})`);
    }
    if (this.podMembers) {
      const face = this.podMembers.get(agentKey);
      if (!face) throw new RangeError(`updateMemberModel: agentKey '${agentKey}' is not a member of pod ${this.key}`);
      face.provider = provider;
      face.model = model;
      return;
    }
    // Solo: the single-member face. The manager addresses the runtime's own
    // key; absent means the same single member.
    if (agentKey != null && agentKey !== this.key) {
      throw new RangeError(`updateMemberModel: agentKey '${agentKey}' does not match solo runtime ${this.key}`);
    }
    // Each update moves the boundary: everything already seen through this
    // adapter (parked with a previous model included) keeps its model; only
    // sessions first dispatched after this call compose the new one.
    this.#soloLegacy = new Set(this.#soloSessions);
    this.#soloFace = { provider, model };
  }

  // The model this runtime would compose for a NEW session of one member —
  // the parked face the manager's reconcile compares the descriptor against.
  // Solo runtimes report the hot face once updated, else the spawn-level
  // model every session composes with. Unknown pod members answer null.
  memberModelOf(agentKey) {
    if (this.podMembers) {
      const face = this.podMembers.get(agentKey);
      return face ? { provider: face.provider, model: face.model } : null;
    }
    return {
      provider: this.#soloFace?.provider ?? this.spawnSpec.provider,
      model: this.#soloFace?.model ?? this.spawnSpec.model,
    };
  }

  // Active turns for ONE member (pod health): collector keys carry the member
  // prefix, so the count is a prefix scan. A solo runtime reports its own
  // aggregate for any key.
  agentActiveTurns(agentKey) {
    if (!this.podMembers) return this.#activeTurns;
    const prefix = `${agentKey}--`;
    let n = 0;
    for (const sid of this.#collectors.keys()) if (sid.startsWith(prefix)) n += 1;
    return n;
  }

  // Pod members' sessions live in one shared home — the wire id namespaces
  // the member so two members' conversations can never collide on storage or
  // collectors. `--` is the separator: agentKeyFor's alphabet yields single
  // dashes only (registry paths use single separators), and the
  // external-context reap splits on the LAST `--` to recover the bare
  // sessionKeyFor tail.
  static wireSessionId(agentKey, sessionId) {
    return `${agentKey}--${sessionId}`;
  }

  async start() {
    if (this.#ready) return;
    const { profile, patchPaths, cwd, env, provider, model, presetId } = this.spawnSpec;
    const args = ["--profile", profile, ...patchPaths.flatMap((p) => ["--patch", p])];
    const client = this.clientFactory
      ? this.clientFactory({ args, cwd, env })
      : null;
    if (!client) throw new Error("DshHarnessAdapter requires a clientFactory (real spawn factory wired in index.js)");
    client.start();
    let res;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          res = await client.initialize({
            cwd,
            provider,
            model,
            ...(presetId ? { agentPreset: presetId } : {}),
          });
          break;
        } catch (e) {
          if (!/no adapter registered for provider/.test(e?.message || "") || attempt >= this.initRetries) throw e;
          if (attempt === 0) this.log.warn(`[agent-runner:${this.key}] initialize racing adapter registration; retrying...`);
          await sleep(500);
        }
      }
    } catch (e) {
      // The spawn is already live (client.start() ran) — closing it here is
      // the difference between a failed cold start and an orphaned dsh
      // holding 100-200MB until the container dies (fix-agent-serving-
      // stability 2.1: `this.client` is only assigned on success, so without
      // this the only reference to the live process goes out of scope).
      try {
        await client.stop?.();
      } catch { /* best-effort — the original failure is what surfaces */ }
      throw e;
    }
    this.client = client;
    this.#ready = true;
    this.subscription = client.subscribe();
    this.#pump();
    return res;
  }

  async #pump() {
    while (this.#ready && this.client) {
      let notif;
      try {
        notif = await this.subscription.next();
      } catch {
        this.#ready = false;
        this.client = null;
        // Fail every in-flight turn: the runtime that would have reported
        // idle is gone (same wedge-avoidance as DshBridge's crash path).
        for (const collector of this.#collectors.values()) {
          try {
            collector({ method: "_child_exit", params: {} });
          } catch { /* collector settles itself */ }
        }
        this.log.warn(`[agent-runner:${this.key}] child exited unexpectedly`);
        try {
          this.onExit?.();
        } catch { /* a broken hook must never break the pump */ }
        return;
      }
      // bot_notify (add-agent-notifications D1): the child's tool sends
      // `botNotify/send` up; the host executes it (binding/rate/relay) and the
      // answer travels back as a `botNotify/result` REQUEST — the two
      // directions the transport carries (the ask precedent). Fire-and-forget
      // so a slow relay never blocks the notification pump.
      if (notif?.method === "botNotify/send") {
        this.#handleNotify(notif.params ?? {});
        continue;
      }
      // Matters (add-matter-threads D3): the facade child's trio sends
      // `matterCall/send` up; the host executes it (bounds/facet route) and
      // the answer travels back as a `matterCall/result` REQUEST — the same
      // two-direction contract as notify.
      if (notif?.method === "matterCall/send") {
        this.#handleMatter(notif.params ?? {});
        continue;
      }
      const sid = notif?.params?.sessionId;
      const collector = sid ? this.#collectors.get(sid) : null;
      if (collector) {
        try {
          collector(notif);
        } catch (e) {
          this.log.error(`[agent-runner:${this.key}] collector failed: ${e?.message || e}`);
        }
      }
    }
  }

  // Execute one bot_notify call with host authority and hand the result back
  // to the child's parked tool call. Every path answers (a declined call must
  // reach the turn, never hang it); a failed answer write only logs — the
  // child's own wait ceiling covers a lost reply.
  async #handleNotify(params) {
    let result;
    try {
      result = this.onNotify
        ? await this.onNotify({ event: params.event, text: params.text, channel: params.channel })
        : { ok: false, reason: "not-configured", message: "notifications are not configured on this deployment" };
    } catch (e) {
      result = { ok: false, reason: "forward-failed", message: `the notification could not be forwarded: ${e?.message || e}` };
    }
    const notifyId = typeof params.notifyId === "string" ? params.notifyId : null;
    if (!notifyId) return;
    try {
      await this.client?.request?.("botNotify/result", { notifyId, ...result });
    } catch (e) {
      this.log.warn(`[agent-runner:${this.key}] notify result could not reach the child: ${e?.message || e}`);
    }
  }

  // Execute one matter call with host authority (the #handleNotify contract,
  // callId-keyed). Facade children only — the manager wires onMatter solely
  // for descriptors carrying a facade block; a non-facade child structurally
  // cannot send this notification (its tool face has no matter trio).
  async #handleMatter(params) {
    let result;
    try {
      result = this.onMatter
        ? await this.onMatter({ op: params.op, args: params.args })
        : { ok: false, reason: "not-configured", message: "matters are not configured on this deployment" };
    } catch (e) {
      result = { ok: false, reason: "forward-failed", message: `the matter call could not be forwarded: ${e?.message || e}` };
    }
    const callId = typeof params.callId === "string" ? params.callId : null;
    if (!callId) return;
    try {
      await this.client?.request?.("matterCall/result", { callId, ...result });
    } catch (e) {
      this.log.warn(`[agent-runner:${this.key}] matter result could not reach the child: ${e?.message || e}`);
    }
  }

  // The dsh deep-control lane (the platform bridge's live methods). Kept as a
  // plain passthrough: unknown methods surface the client's own error.
  async request(method, params) {
    if (!this.client?.request) throw unsupportedCapability(this.name, method);
    return this.client.request(method, params);
  }

  // Run one turn. `onDelta` (optional) receives incremental text — the SSE
  // bridge for message/stream. `onAsk` (optional, add-serving-ask-bridge D3)
  // receives each in-flight ask `{askId, sessionId, questions, deadlineAt}` —
  // the same mid-turn, session-bound lane deltas ride. A turn WITHOUT an
  // answerer declines every ask itself: the tool must fail fast with a
  // caller-cannot-answer result, never wait out the bridge's fallback timer
  // (self-turns and every non-opt-in internal caller). The ask window is the
  // remaining turn budget less a grace interval (askGraceMs): the adapter
  // cancels an unanswered ask at the deadline so the agent finishes the turn
  // normally instead of taking the -32001 hard stop.
  // Sessions are lazy: the bridge creates-or-resumes by id, so a known
  // contextId continues its conversation. Pod runtimes take `agentKey`: the
  // turn addresses the member's namespaced wire session (storage +
  // collectors), its first use parks the member's preset and model for that
  // session (the bridge composes both at the session's lazy creation), and
  // the member's own turn budget applies. Every exit path settles exactly
  // once (prompt rejection included), or the activeTurns counter leaks and a
  // later drain would wedge.
  async turn(sessionId, text, { onDelta, agentKey, onAsk, onEvent } = {}) {
    const member = this.podMembers?.get(agentKey);
    if (this.podMembers && !member) {
      throw Object.assign(new Error(`agentKey '${agentKey}' is not a member of pod ${this.key}`), { code: -32000 });
    }
    const wireId = member ? DshHarnessAdapter.wireSessionId(agentKey, sessionId) : sessionId;
    // First use of a member session: park its persona and model BEFORE the
    // prompt — the session's lazy creation composes both (the bridge's parked
    // maps). A failure here fails the turn before any collector exists, the
    // same settle-once shape a prompt rejection has.
    if (member && !this.#prepared.has(wireId)) {
      await this.client.request("preset/set", { sessionId: wireId, presetId: member.presetId });
      await this.client.request("model/set", { sessionId: wireId, provider: member.provider, model: member.model });
      this.#prepared.add(wireId);
    }
    // Solo model hot-swap (add-model-session-boundary): once an update has
    // landed on this runtime, sessions first seen AFTER it park the new model
    // before their first prompt — the same lazy-creation composition pod
    // members use, minus the preset (solo presets stay process-level).
    // Sessions seen before the update (#soloLegacy) never park: they keep the
    // model they were composed with, in-flight turns untouched. Recorded
    // BEFORE any await so an update landing mid-park sees this session as
    // already in existence.
    if (!member) {
      this.#soloSessions.add(sessionId);
      if (this.#soloFace && !this.#soloLegacy.has(sessionId) && !this.#prepared.has(sessionId)) {
        await this.client.request("model/set", { sessionId, provider: this.#soloFace.provider, model: this.#soloFace.model });
        this.#prepared.add(sessionId);
      }
    }
    this.#activeTurns += 1;
    const turnTimeoutMs = member?.turnTimeoutMs ?? this.turnTimeoutMs;
    const budgetLabel = member?.budgetLabel ?? this.budgetLabel;
    let settle;
    const collected = new Promise((resolve, reject) => {
      let graceTimer = null;
      let askTimer = null;
      const turnStartedAt = Date.now();
      // Settle ONCE (the contract above): the collector path (`_child_exit`)
      // and the prompt-failure path can both fire for the same turn — the
      // second one must not decrement the active-turn counter again.
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        clearTimeout(askTimer);
        this.#collectors.delete(wireId);
        this.#activeTurns -= 1;
        fn(arg);
      };
      settle = (ok, arg) => done(ok ? resolve : reject, arg);
      // Over-budget (add-serving-budgets D3): settle with a structured error
      // naming the bound. SOLO keeps the ADR-0014 ④ hard stop (mark + the
      // manager stops the process). POD is cancel-first (add-dsh-pod-adapter):
      // the member's session is aborted through the bridge's native
      // session/cancel and the idle it converges to settles the budget error —
      // the pod and its sibling members keep serving. Only when the cancel
      // fails to converge within the grace window is the runtime marked for
      // the manager's hard stop (last resort: a wedged turn would starve every
      // member's close lane — the process-level serialization this design
      // accepts).
      const aborting = { value: false };
      const budgetError = () => Object.assign(new Error(`turn budget (${budgetLabel}) exceeded`), { code: -32001 });
      const timer = setTimeout(() => {
        aborting.value = true;
        if (!this.podMembers) {
          this.#budgetKilled = true;
          return settle(false, budgetError());
        }
        try {
          this.client?.request?.("session/cancel", { sessionId: wireId }).catch(() => {});
        } catch { /* best-effort — the grace timer is the backstop */ }
        graceTimer = setTimeout(() => {
          this.#budgetKilled = true;
          settle(false, budgetError());
        }, this.budgetCancelGraceMs);
      }, turnTimeoutMs);
      let finalText = "";
      let lastUsage = null;
      // Turn-local callId→tool-name map for the memory onEvent lane (P0 D2):
      // dsh's tool/result carries no tool name, so the collector recalls it
      // from the matching tool/call.
      const toolNames = new Map();
      this.#collectors.set(wireId, (notif) => {
        const { method, params } = notif;
        const ev0 = params?.event;
        const usage0 = ev0?.data?.usage ?? ev0?.usage ?? params?.usage;
        if (usage0 && typeof usage0 === "object") lastUsage = usage0;
        if (method === "session.status" && params?.status === "idle") {
          if (aborting.value) {
            // The budget cancel converged: the turn settles as a budget
            // error even if partial text arrived (the caller asked for a
            // bounded turn; the meter must record the kill, not a truncated
            // success).
            return settle(false, budgetError());
          }
          // Empty-turn recognition (fix-empty-turn-billing): a turn that ends
          // without any assistant text is the silent shape of model failure —
          // dsh goes idle without ever emitting a finish-error chunk
          // (UNKNOWN_MODEL-class resolution failures). Settled as a failed
          // turn so the meter, the fleet events, and the A2A reply all carry
          // an error and billing waives it. Text is the only honest signal:
          // usage never arrives on this dsh line (live finding 2026-10-14 —
          // 700/700 ok:true meter rows carry tokens:null), so a null usage
          // proves nothing. -32005 stays distinct from -32003 (a failure the
          // LLM request itself reported) for triage attribution.
          if (!finalText.trim()) {
            return settle(false, Object.assign(
              new Error("turn ended without any assistant output (model unavailable or refused)"),
              { code: -32005 },
            ));
          }
          return settle(true, { text: finalText, usage: lastUsage });
        }
        if (method === "_child_exit") {
          return settle(false, Object.assign(new Error("agent runtime exited mid-turn"), { code: -32002 }));
        }
        // In-flight ask (add-serving-ask-bridge): the bridge parked the tool
        // call and notified `{sessionId, askId, questions}` on this wire id.
        // With an answerer, forward it with the deadline and arm the
        // deadline cancel; without one, decline now — the tool fails with a
        // caller-cannot-answer result and the turn continues at once.
        if (method === "userQuestion/ask") {
          const askId = typeof params?.askId === "string" ? params.askId : "";
          const questions = Array.isArray(params?.questions) ? params.questions : null;
          if (!askId || !questions) return;
          const answer = (payload) => {
            Promise.resolve(this.client?.request?.("userQuestions/answer", { askId, ...payload })).catch(() => {});
          };
          if (typeof onAsk !== "function") {
            answer({ cancelled: true, reason: "the caller cannot answer questions" });
            return;
          }
          // Deadline floor: at least min(1s, half the budget) so a tiny test
          // budget still leaves a usable window — but never past the budget.
          const askWindow = Math.max(Math.min(1_000, Math.floor(turnTimeoutMs / 2)), turnTimeoutMs - this.askGraceMs);
          const deadlineAt = turnStartedAt + askWindow;
          clearTimeout(askTimer);
          askTimer = setTimeout(() => {
            answer({ cancelled: true, reason: "the ask window closed before the user answered" });
          }, Math.max(0, deadlineAt - Date.now()));
          askTimer.unref?.();
          try {
            onAsk({ askId, sessionId: String(params?.sessionId ?? wireId), questions, deadlineAt });
          } catch (e) {
            this.log.warn(`[agent-runner:${this.key}] onAsk failed: ${e?.message || e}`);
          }
          return;
        }
        // Live delta lane (restore-assistant-stream-020): the 0.2.0 session
        // format removed the assistant/chunk event — text deltas and finish
        // errors ride the bridge-forwarded platform/stream frames now.
        if (method === "platform/stream") {
          const chunk = params?.frame?.chunk;
          if (chunk?.type === "text-delta" && chunk.text) {
            onDelta?.(chunk.text);
          } else if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
            settle(false, Object.assign(new Error(chunk.reason.failure?.message || "LLM request failed"), { code: -32003 }));
          }
          return;
        }
        if (method !== "session.event") return;
        const ev = params?.event;
        // Memory onEvent lane (fix-memory-capture-p0 D2): tool events ride the
        // same collector the text lane uses; observation never becomes a turn
        // failure, so the callback is guarded end to end.
        const toolEv = dshToolEvent(ev, toolNames);
        if (toolEv) {
          try { onEvent?.(toolEv); } catch { /* observation never load-bearing */ }
          return;
        }
        if (ev?.type === "assistant/message") {
          const blocks = ev.data?.message?.content;
          if (Array.isArray(blocks)) {
            const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
            if (t) finalText = t;
          }
        }
      });
    });
    // The rejection must never be UNHANDLED, and the turn must never HANG
    // (add-local-fleet-control-plane F3 — spike 1.1 crash-excerpt.txt:
    // "agent runtime exited mid-turn" at this file's `_child_exit` branch
    // killed the whole runner, taking every hosted agent with it):
    //
    //   1. `collected` is created here but only RETURNED after the prompt
    //      resolves — so a rejection landing in that window (the child died
    //      mid-request) had no handler attached and Node took the process
    //      down. The no-op catch marks it handled; the caller still receives
    //      the rejection when it awaits `collected` below.
    //   2. When the child dies, the outstanding write may never complete (the
    //      bytes are buffered, the process is gone) — so the prompt promise
    //      can stay pending FOREVER while the outcome is already known from
    //      the subscription's EOF. Racing the two means the turn ends on
    //      whichever settles first, instead of hanging until the caller gives
    //      up.
    collected.catch(() => {});
    const promptOutcome = this.client
      .prompt(wireId, [{ type: "text", text }])
      .catch((e) => {
        settle(false, e);
      });
    await Promise.race([promptOutcome, collected.catch(() => {})]);
    return collected;
  }

  async stop() {
    this.#ready = false;
    const client = this.client;
    this.client = null;
    try {
      await client?.stop?.();
    } catch { /* best-effort */ }
  }
}
