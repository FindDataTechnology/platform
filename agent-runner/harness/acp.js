// ── AcpHarnessAdapter (add-harness-adapter D3/D4) ────────────────────────────
//
// Drives ANY ACP-speaking agent binary (Agent Client Protocol over stdio) as a
// harness: the second implementation of the adapter contract, and the seam
// that makes 萬星's serving substrate harness-independent (dsh today,
// claude-code-acp / codex-acp next — both npm-published stdio ACP agents).
//
// The wire is hand-rolled newline-delimited JSON-RPC — the same shape the
// contracts suite's mini client and the fake agent use — deliberately NOT the
// @agentclientprotocol/sdk package: that SDK sits in the dsh tree as a
// transitive dependency, and making it a direct production dependency would
// put a second version-discipline surface into the runner image. Contract ⑰
// pins this mapping against a local fake agent, so drift is caught by the
// suite, not by an outage.
//
// Mapping (design D4):
//   start        → spawn + `initialize` handshake
//   session      → lazy `session/new {cwd (absolute), mcpServers: {}}` per context
//   model        → `session/set_config_option {configId:"model", value: JSON.stringify([provider,model])}`
//   turn         → `session/prompt` → settle on the response's stopReason
//   onDelta      → `session/update` → agent_message_chunk content deltas
//   usage        → `session/update` → usage_update notifications (verbatim to the caller)
//   cancel       → `session/cancel` notification + the prompt's `cancelled` stopReason
//   stop         → close stdin → SIGTERM → SIGKILL ladder
//   resume       → `session/resume` when the agent advertises loadSession;
//                  otherwise the context starts a fresh session (never mixed)
//
// Error families stay uniform with the dsh path so metering/billing semantics
// are harness-independent: an empty turn settles -32005, a runtime that cannot
// start fails the spawn (-32004 at the manager layer), a cancelled turn
// settles -32001 through the manager's budget path.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { unsupportedCapability } from "./adapter.js";

const HANDSHAKE_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_000;

// Text of one ACP tool-call content list, in either shape seen on the wire
// (fix-memory-capture-p0 4.1, verified against the vendored dsh-acp bridge):
// the bridge wraps every block — content: [{type:"content", content:<block>}] —
// while spec-native agents (claude-code-acp) emit the blocks directly.
function acpToolText(content) {
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const b of content) {
    const inner = b?.type === "content" && b?.content && typeof b.content === "object" ? b.content : b;
    if (inner?.type === "text" && typeof inner.text === "string") out.push(inner.text);
  }
  return out.join("");
}

// One ACP session/update (tool_call | tool_call_update) → the adapter's
// normalized memory-event shape (fix-memory-capture-p0 D2). Exported so the
// collector tests exercise the exact mapping the turn path uses. `toolNames`
// is the turn-local toolCallId→title map — result updates carry no tool name.
// Returns null for other update kinds. Only terminal results (completed /
// failed) map; "pending"/"in_progress" statuses are not observations.
export function acpToolEvent(update, toolNames) {
  if (update?.sessionUpdate === "tool_call") {
    const callId = update.toolCallId ?? null;
    const name = update.title ?? update.kind ?? null;
    if (callId && name && toolNames) toolNames.set(callId, name);
    return { type: "tool_call", callId, toolName: name, args: update.rawInput ?? null };
  }
  if (update?.sessionUpdate === "tool_call_update" &&
      (update.status === "completed" || update.status === "failed")) {
    let text = acpToolText(update.content);
    if (!text && update.rawOutput != null) {
      text = typeof update.rawOutput === "string" ? update.rawOutput : (() => {
        try { return JSON.stringify(update.rawOutput); } catch { return String(update.rawOutput); }
      })();
    }
    return {
      type: "tool_result",
      callId: update.toolCallId ?? null,
      toolName: (toolNames?.get(update.toolCallId)) ?? null,
      resultText: text,
      isError: update.status === "failed",
    };
  }
  return null;
}

export class AcpHarnessAdapter {
  #proc = null;
  #rl = null;
  #pending = new Map(); // request id → {resolve, reject}
  #nextId = 1;
  #sessions = new Map(); // our sessionId (context) → { acpSessionId, model }
  #activeTurns = 0;
  #budgetKilled = false;
  #loadSession = true; // whether the agent advertised session/resume support
  #exited = null; // { code, signal } once the process ends

  constructor({ key, spawnSpec, log = console, onExit = null }) {
    this.name = "acp";
    this.key = key;
    this.spawnSpec = spawnSpec; // { command, args, cwd, env, provider, model, acpMcpServers? }
    this.log = log;
    this.onExit = onExit;
  }

  capabilities() {
    // Honest depth: the ACP wire carries model selection, cancellation, and
    // streaming deltas — and none of dsh's platform depth (no persona parking,
    // no co-hosting). Callers degrade open on absence, so `false` here is the
    // explicit "not supported" that structured refusals name.
    return { liveModel: true, cancel: true, stream: true, perSessionPreset: false, cohost: false, asks: false };
  }

  get ready() {
    return this.#proc !== null && this.#exited === null;
  }

  get activeTurns() {
    return this.#activeTurns;
  }

  get budgetKilled() {
    return this.#budgetKilled;
  }

  pid() {
    return this.#proc?.pid ?? null;
  }

  // ACP is one-session-per-context: our context id IS the session key. The
  // wire-session namespace is a dsh concern and never appears here (a member
  // key passed by a co-hosting caller is ignored — cohost: false).
  isActive(sessionId) {
    return this.#activeTurns > 0 && this.#sessions.has(sessionId);
  }

  agentActiveTurns() {
    return this.#activeTurns;
  }

  async start() {
    if (this.#proc) return;
    const { command, args = [], cwd, env } = this.spawnSpec;
    if (!command) throw new Error("AcpHarnessAdapter requires spawnSpec.command (the runner's harness-command allowlist resolves it)");
    if (!cwd || !isAbsolute(cwd)) {
      throw new Error(`AcpHarnessAdapter requires an absolute cwd (got ${JSON.stringify(cwd)})`);
    }
    const proc = spawn(command, args, { cwd, env: { ...env }, stdio: ["pipe", "pipe", "inherit"] });
    this.#proc = proc;
    this.#rl = createInterface({ input: proc.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));
    proc.once("exit", (code, signal) => {
      this.#exited = { code, signal };
      // Fail every parked request: a dead runtime must never hang a turn.
      for (const [, p] of this.#pending) p.reject(new Error(`ACP agent exited (code ${code}, signal ${signal})`));
      this.#pending.clear();
      this.log.warn(`[agent-runner:${this.key}] acp agent exited (code ${code}, signal ${signal})`);
      try {
        this.onExit?.();
      } catch { /* a broken hook must never break the pump */ }
    });
    try {
      const res = await this.#request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, HANDSHAKE_TIMEOUT_MS);
      this.#loadSession = res?.agentCapabilities?.loadSession !== false;
    } catch (e) {
      // A failed handshake must not leave the process behind (the dsh path's
      // orphan rule, same reasoning: an unowned 100MB+ runtime).
      await this.stop().catch(() => {});
      throw new Error(`ACP initialize failed: ${e?.message || e}`);
    }
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout is not ours to interpret
    }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) {
        p.reject(Object.assign(new Error(`ACP ${msg.error.message || "error"}`), { code: msg.error.code, data: msg.error.data }));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "session/update") this.#onUpdate(msg.params);
  }

  // Streaming deltas ride here; the per-turn collector (registered in turn())
  // consumes them. Unknown update kinds are ignored — the wire is additive by
  // design (compaction/plan/mode updates exist and are not this adapter's).
  #onUpdate(params) {
    const sessionId = params?.sessionId;
    const update = params?.update;
    const collector = sessionId ? this.#turnCollectors?.get(sessionId) : null;
    collector?.(update);
  }

  #turnCollectors = new Map(); // acp session id → update collector

  #request(method, params, timeoutMs = 0) {
    if (this.#exited) return Promise.reject(new Error("ACP agent is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.#proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  #notify(method, params) {
    try {
      this.#proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch { /* a dead pipe surfaces on the next request */ }
  }

  // Ensure (create or resume) the ACP session for one context id.
  async #ensureSession(sessionId) {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const cwd = this.spawnSpec.cwd;
    // A context whose ACP session this runtime no longer holds is either new
    // (fresh session) or a post-restart continuation — resume it when the
    // agent supports resume, otherwise start fresh (never mixed histories).
    const acpSessionId = `ctx-${String(sessionId).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    if (this.#loadSession) {
      try {
        await this.#request("session/resume", { sessionId: acpSessionId, cwd });
        const rec = { acpSessionId, model: null };
        this.#sessions.set(sessionId, rec);
        return rec;
      } catch { /* unknown session → create below */ }
    }
    // mcpServers is an ARRAY on the ACP wire (schema.json: items → McpServer;
    // SDK 0.14+). The dsh-era object-map shape came from contract ⑬'s dsh ACP
    // profile, whose value form is its own — the fake agent tolerated both,
    // the real claude-code-acp zod schema rejected the map. The items are the
    // http branch (type:"http", name, url, headers-as-entry-array) built by
    // compose-acp.js's acpMcpServers from the deployment's registry MCP
    // references; the spawn spec carries them so every session created for
    // this agent mounts the same servers.
    // The model rides _meta.claudeCode.options.model — claude-code-acp spreads
    // that into its Claude Agent SDK options, and WITHOUT it the SDK boots on
    // its built-in default (claude-sonnet-4-5), which a gateway-backed account
    // cannot resolve (live E2E finding, 2026-10-14). set_config_option stays
    // for agents that support live model config, but the boot model must be
    // right for the ones that do not.
    const createParams = {
      cwd,
      mcpServers: Array.isArray(this.spawnSpec.acpMcpServers) ? this.spawnSpec.acpMcpServers : [],
      ...(this.spawnSpec.model ? { _meta: { claudeCode: { options: { model: this.spawnSpec.model } } } } : {}),
    };
    const res = await this.#request("session/new", createParams);
    const rec = { acpSessionId: res?.sessionId ?? acpSessionId, model: null };
    this.#sessions.set(sessionId, rec);
    return rec;
  }

  // Model selection maps to the ACP config option. `provider` rides inside the
  // JSON value because the wire's shape is [provider, model] (contract ⑬'s
  // empirically-pinned shape for the dsh ACP profile; the fake agent asserts
  // the same parse). Providers whose ACP agent ignores model config simply
  // keep their default — the call succeeding is the agent's contract.
  async setModel(sessionId, provider, model) {
    const rec = await this.#ensureSession(sessionId);
    await this.#request("session/set_config_option", {
      sessionId: rec.acpSessionId,
      configId: "model",
      value: JSON.stringify([provider, model]),
    });
    rec.model = [provider, model];
    return rec;
  }

  async turn(sessionId, text, { onDelta, onEvent } = {}) {
    if (!this.ready) throw new Error("ACP agent is not running");
    // Counted from the top: the contract says an in-flight turn (session
    // setup included) is visible on activeTurns the moment turn() is called —
    // the manager's in-flight lane discipline reads it synchronously.
    this.#activeTurns += 1;
    try {
      const rec = await this.#ensureSession(sessionId);
      // Apply the spawn-time model once per session (the descriptor's effective
      // model; a live switch goes through request("session/set_config_option")).
      if (!rec.model && this.spawnSpec.provider && this.spawnSpec.model) {
        try {
          await this.setModel(sessionId, this.spawnSpec.provider, this.spawnSpec.model);
        } catch (e) {
          // An agent that does not implement model config is still usable.
          this.log.warn(`[agent-runner:${this.key}] ACP model selection unavailable (${e?.message || e}); running on the agent default`);
        }
      }
      let text_acc = "";
      let usage = null;
      // Turn-local toolCallId→tool-name map for the memory onEvent lane
      // (P0 D2): result updates carry no tool name, so it is recalled from
      // the matching tool_call update.
      const toolNames = new Map();
      this.#turnCollectors.set(rec.acpSessionId, (update) => {
        if (update?.sessionUpdate === "agent_message_chunk") {
          const piece = typeof update?.content?.text === "string" ? update.content.text : "";
          if (piece) {
            text_acc += piece;
            onDelta?.(piece);
          }
        } else if (update?.sessionUpdate === "usage_update") {
          usage = update;
        } else {
          // Memory onEvent lane: tool lifecycle updates ride the same
          // collector as the text lane; observation never becomes a turn
          // failure, so the callback is guarded end to end.
          const toolEv = acpToolEvent(update, toolNames);
          if (toolEv) {
            try { onEvent?.(toolEv); } catch { /* observation never load-bearing */ }
          }
        }
      });
      let stopReason = null;
      try {
        const res = await this.#request("session/prompt", {
          sessionId: rec.acpSessionId,
          prompt: [{ type: "text", text }],
        });
        stopReason = res?.stopReason ?? null;
      } finally {
        this.#turnCollectors.delete(rec.acpSessionId);
      }
      // Cancellation maps to the dsh budget family: the manager's budget path
      // settles the structured error; the adapter only reports what happened.
      if (stopReason === "cancelled") {
        return { text: text_acc, usage, cancelled: true };
      }
      // Empty-turn recognition (same discipline as the dsh path): a turn that
      // produced no assistant text is the silent shape of failure — settle with
      // the -32005 family so metering/billing waive it identically.
      if (!text_acc.trim()) {
        throw Object.assign(
          new Error("turn ended without any assistant output (model unavailable or refused)"),
          { code: -32005 },
        );
      }
      return { text: text_acc, usage };
    } finally {
      this.#activeTurns -= 1;
    }
  }

  // The deep-control lane: the ACP wire's own control surface, addressed by
  // the platform bridge's method names where they map (model/set,
  // session/cancel). Anything else is explicitly unsupported — never a
  // silent no-op (the contract suite asserts this).
  async request(method, params) {
    if (method === "model/set") {
      const sessionId = params?.sessionId;
      if (!sessionId || !params?.provider || !params?.model) throw new Error("model/set requires sessionId, provider and model");
      await this.setModel(sessionId, params.provider, params.model);
      return { ok: true, applied: true };
    }
    if (method === "session/cancel") {
      const sessionId = params?.sessionId;
      const rec = sessionId ? this.#sessions.get(sessionId) : null;
      if (rec) this.#notify("session/cancel", { sessionId: rec.acpSessionId });
      return { ok: true };
    }
    throw unsupportedCapability(this.name, method);
  }

  async stop() {
    const proc = this.#proc;
    this.#proc = null;
    this.#rl?.close();
    this.#rl = null;
    if (!proc || this.#exited) return;
    try {
      proc.stdin.end();
    } catch { /* already closed */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch { /* gone */ }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch { /* gone */ }
          resolve();
        }, STOP_GRACE_MS).unref?.();
      }, STOP_GRACE_MS);
      timer.unref?.();
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
