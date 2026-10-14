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

const INIT_RETRIES = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DshHarnessAdapter {
  #collectors = new Map(); // wire session id → turn collector
  // Pod members whose sessions were prepared on THIS runtime (add-dsh-pod-adapter):
  // preset/set + model/set parked before the session's first prompt. A rebuilt
  // runtime starts empty and re-parks on first touch — which is exactly what a
  // resumed persisted session needs (the bridge resolves the parked preset on
  // the resume path too, so composition cannot drift across rebuilds).
  #prepared = new Set();
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
  constructor({ key, spawnSpec, clientFactory, log = console, onNotify = null, onExit = null, podMembers = null, budgetCancelGraceMs = 10_000, turnTimeoutMs = 180_000, budgetLabel = null, initRetries = INIT_RETRIES }) {
    this.name = "dsh";
    this.key = key;
    this.spawnSpec = spawnSpec; // { profile, patchPaths, cwd, env, provider, model, presetId, version }
    this.clientFactory = clientFactory;
    this.log = log;
    this.onNotify = onNotify;
    this.onExit = onExit;
    this.podMembers = podMembers;
    this.budgetCancelGraceMs = budgetCancelGraceMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.budgetLabel = budgetLabel ?? `${Math.max(1, Math.ceil(turnTimeoutMs / 60_000))}m`;
    this.initRetries = initRetries;
    this.client = null;
    this.subscription = null;
  }

  capabilities() {
    return { liveModel: true, cancel: true, stream: true, perSessionPreset: true, cohost: true };
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

  // The dsh deep-control lane (the platform bridge's live methods). Kept as a
  // plain passthrough: unknown methods surface the client's own error.
  async request(method, params) {
    if (!this.client?.request) throw unsupportedCapability(this.name, method);
    return this.client.request(method, params);
  }

  // Run one turn. `onDelta` (optional) receives incremental text — the SSE
  // bridge for message/stream. Sessions are lazy: the bridge creates-or-
  // resumes by id, so a known contextId continues its conversation.
  // Pod runtimes take `agentKey`: the turn addresses the member's namespaced
  // wire session (storage + collectors), its first use parks the member's
  // preset and model for that session (the bridge composes both at the
  // session's lazy creation), and the member's own turn budget applies.
  // Every exit path settles exactly once (prompt rejection included), or the
  // activeTurns counter leaks and a later drain would wedge.
  async turn(sessionId, text, { onDelta, agentKey } = {}) {
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
    this.#activeTurns += 1;
    const turnTimeoutMs = member?.turnTimeoutMs ?? this.turnTimeoutMs;
    const budgetLabel = member?.budgetLabel ?? this.budgetLabel;
    let settle;
    const collected = new Promise((resolve, reject) => {
      let graceTimer = null;
      const done = (fn, arg) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
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
        if (ev?.type === "assistant/message") {
          const blocks = ev.data?.message?.content;
          if (Array.isArray(blocks)) {
            const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
            if (t) finalText = t;
          }
        }
      });
    });
    try {
      await this.client.prompt(wireId, [{ type: "text", text }]);
    } catch (e) {
      settle(false, e);
    }
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
