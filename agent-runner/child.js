// ── One deployed role's runtime child (add-a2a-agent-serving 4.2/4.4) ───────
//
// Spawns a dedicated dsh child over stdio JSON-RPC (HarnessClient — the same
// SDK class the platform's DshBridge drives), initialized with the role's
// composed persona preset and the runner's provider/model. Turns are the
// bots.js collector pattern: register a per-session notification collector,
// prompt, settle on session.status idle — with text-delta streaming exposed
// for message/stream.
//
// `clientFactory` is injectable so unit tests drive a fake harness; the
// default factory is the real spawn (initialize retries the adapter-
// registration race exactly like DshBridge).

const INIT_RETRIES = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  #collectors = new Map(); // dsh session id → turn collector
  // `turnTimeoutMs` IS this child's effective turn budget (add-serving-budgets
  // D3: the descriptor's minutes, else the runner default); `budgetLabel` is
  // the human bound the over-budget error names ("20m").
  // `notifyHandler` (add-agent-notifications D1): the host-side executor for
  // this child's `botNotify/send` notifications — the manager supplies it with
  // the deployment's bound channel. Absent → the call is declined
  // not-configured, never silently dropped.
  constructor({ key, spawnSpec, turnTimeoutMs = 180_000, budgetLabel, clientFactory, log = console, notifyHandler }) {
    this.key = key;
    this.spawnSpec = spawnSpec; // { dshBin, profile, patchPaths, cwd, env, provider, model, presetId }
    this.turnTimeoutMs = turnTimeoutMs;
    this.budgetLabel = budgetLabel ?? `${Math.max(1, Math.ceil(turnTimeoutMs / 60_000))}m`;
    this.clientFactory = clientFactory;
    this.log = log;
    this.notifyHandler = notifyHandler ?? null;
    this.client = null;
    this.ready = false;
    this.draining = false; // no NEW sessions/turns; in-flight ones finish
    // Set when a turn settles by budget timeout (never reset: a killed child
    // is discarded — the manager removes it and the next touch re-spawns).
    this.budgetKilled = false;
    this.lastActivityAt = Date.now();
    this.spawnedAt = Date.now(); // warm-zone hysteresis anchor (manager)
    this.activeTurns = 0;
    this.version = spawnSpec.version ?? null;
  }

  // Best-effort process id for RSS sampling (the warm-zone budget). The
  // harness client owns the spawn; whatever shape it exposes is accepted,
  // null means "use the fixed per-agent cost instead".
  get pid() {
    return this.client?.pid?.() ?? this.client?.pid ?? this.client?.proc?.pid ?? this.client?.child?.pid ?? null;
  }

  get state() {
    if (this.draining) return "draining";
    return this.ready ? "serving" : "starting";
  }

  // Whether a session on this child has a turn in flight (the external-
  // context reap pass skips active sessions; add-wanxing-serving-api D10).
  isActive(sessionKey) {
    return this.#collectors.has(sessionKey);
  }

  async start() {
    if (this.ready) return;
    const { profile, patchPaths, cwd, env, provider, model, presetId } = this.spawnSpec;
    const args = ["--profile", profile, ...patchPaths.flatMap((p) => ["--patch", p])];
    const client = this.clientFactory
      ? this.clientFactory({ args, cwd, env })
      : null;
    if (!client) throw new Error("AgentChild requires a clientFactory (real spawn factory wired in index.js)");
    client.start();
    let res;
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
        if (!/no adapter registered for provider/.test(e?.message || "") || attempt >= INIT_RETRIES) throw e;
        if (attempt === 0) this.log.warn(`[agent-runner:${this.key}] initialize racing adapter registration; retrying...`);
        await sleep(500);
      }
    }
    this.client = client;
    this.ready = true;
    this.subscription = client.subscribe();
    this.#pump();
    return res;
  }

  async #pump() {
    while (this.ready && this.client) {
      let notif;
      try {
        notif = await this.subscription.next();
      } catch {
        this.ready = false;
        this.client = null;
        // Fail every in-flight turn: the runtime that would have reported
        // idle is gone (same wedge-avoidance as DshBridge's crash path).
        for (const collector of this.#collectors.values()) {
          try {
            collector({ method: "_child_exit", params: {} });
          } catch { /* collector settles itself */ }
        }
        this.log.warn(`[agent-runner:${this.key}] child exited unexpectedly`);
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
      result = this.notifyHandler
        ? await this.notifyHandler({ event: params.event, text: params.text, channel: params.channel })
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

  // Run one turn. `onDelta` (optional) receives incremental text — the SSE
  // bridge for message/stream. Sessions are lazy: the bridge creates-or-
  // resumes by id, so a known contextId continues its conversation.
  // Every exit path settles exactly once (prompt rejection included), or the
  // activeTurns counter leaks and a later drain would wedge.
  async turn(sessionId, text, { onDelta } = {}) {
    if (this.draining) {
      throw Object.assign(new Error("this agent is draining (upgrade or undeploy in progress)"), { code: -32000 });
    }
    this.lastActivityAt = Date.now();
    this.activeTurns += 1;
    let settle;
    const collected = new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearTimeout(timer);
        this.#collectors.delete(sessionId);
        this.activeTurns -= 1;
        this.lastActivityAt = Date.now();
        fn(arg);
      };
      settle = (ok, arg) => done(ok ? resolve : reject, arg);
      const timer = setTimeout(() => {
        // Over-budget (add-serving-budgets D3): settle with a structured
        // error naming the bound and mark the child — the manager stops it
        // on this marker (ADR-0014 ④ hard stop: dsh has no interrupt RPC,
        // so the turn dies with the process; durable state is on disk and
        // the next touch re-spawns a fresh child).
        this.budgetKilled = true;
        settle(false, Object.assign(new Error(`turn budget (${this.budgetLabel}) exceeded`), { code: -32001 }));
      }, this.turnTimeoutMs);
      let finalText = "";
      let lastUsage = null;
      this.#collectors.set(sessionId, (notif) => {
        const { method, params } = notif;
        const ev0 = params?.event;
        const usage0 = ev0?.data?.usage ?? ev0?.usage ?? params?.usage;
        if (usage0 && typeof usage0 === "object") lastUsage = usage0;
        if (method === "session.status" && params?.status === "idle") {
          return settle(true, { text: finalText, usage: lastUsage });
        }
        if (method === "_child_exit") {
          return settle(false, Object.assign(new Error("agent runtime exited mid-turn"), { code: -32002 }));
        }
        if (method !== "session.event") return;
        const ev = params?.event;
        if (ev?.type === "assistant/message") {
          const blocks = ev.data?.message?.content;
          if (Array.isArray(blocks)) {
            const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
            if (t) finalText = t;
          }
        } else if (ev?.type === "assistant/chunk") {
          const chunk = ev.data?.chunk;
          if (chunk?.type === "text-delta" && chunk.text) {
            onDelta?.(chunk.text);
          } else if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
            settle(false, Object.assign(new Error(chunk.reason.failure?.message || "LLM request failed"), { code: -32003 }));
          }
        }
      });
    });
    try {
      await this.client.prompt(sessionId, [{ type: "text", text }]);
    } catch (e) {
      settle(false, e);
    }
    return collected;
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
    this.ready = false;
    const client = this.client;
    this.client = null;
    try {
      await client?.stop?.();
    } catch { /* best-effort */ }
  }
}
