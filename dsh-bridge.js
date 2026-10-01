// dsh-bridge.js — stdio JSON-RPC bridge to a DeepSeek Harness runtime.
//
// Spawns `dsh --profile <name>` as a child process and drives it through the
// `@deepseek-ai/dsh-sdk-client` HarnessClient, which owns the wire-level
// concerns (spawn, newline-delimited JSON-RPC framing, request/response id
// correlation, notification subscription, the EOF→SIGTERM→SIGKILL close
// ladder). This module adds only what the SDK leaves to the host: process
// lifecycle (spawn on startup, unexpected-exit → restart-with-backoff,
// terminate on shutdown), a health/ready flag, and a single notification pump
// that fans every server notification into the `onEvent` callback. Task 2
// fills `onEvent` with the dsh→WS event-translation map.
//
// The command is `dsh --profile platform` rather than the `dsh-jsonrpc-agent`
// bin: the bin boots a bare cordis.yml and bypasses the profile's
// package.json bundles, so an empty tree exits 0 immediately. The `dsh` CLI
// applies the profile layers (dsh-base + cordis.patch.yml sdk-jsonrpc-server
// row), boots the `agents` service the server plugin injects, and serves
// clean JSON-RPC on stdio with no REPL/banner noise when stdin is a pipe.
//
// dsh is now the sole agent runtime — the pi path was removed in the
// migrate-pi-to-dsh change (no AGENT_RUNTIME branch left to roll back to).

import { HarnessClient, TransportClosedError } from "@deepseek-ai/dsh-sdk-client";
import { fileURLToPath } from "node:url";

const COMMAND = process.env.DSH_BIN || "dsh";
const PROFILE = process.env.DSH_PROFILE || "platform";
const REQUEST_TIMEOUT_MS = Number(process.env.DSH_REQUEST_TIMEOUT_MS) || 60_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
// Backoff ceiling for restart-with-backoff (exponential, capped at 30s).
const MAX_RESTARTS = Number(process.env.DSH_MAX_RESTARTS) || 5;
// RACE: llm-pi-ai registers the volces adapter asynchronously via
// ctx.inject(["settings"]), which fires only AFTER the settings-file provider
// loads+publishes settings.yaml. An initialize arriving before that injection
// → "no adapter registered for provider X". Retry with a short backoff until
// the adapter registers (or this ceiling is hit). 20×500ms = 10s ceiling.
const INIT_RETRIES = Number(process.env.DSH_INIT_RETRIES) || 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The --patch flag list, in load order: an absent path (no MCP servers, no
// skills dir, an unresolvable preset root) simply omits its flag, which is what
// makes every overlay additive and individually optional. The permission overlay
// MUST come after the preset overlay — it swaps the preset bridge's loader row —
// and the two bridge rows come last: each inserts one fresh row and touches
// nothing else.
export function patchArgs(paths = {}) {
  const order = [
    paths.mcpPatchPath,
    paths.skillsPatchPath,
    paths.presetsPatchPath,
    paths.permissionsPatchPath,
    paths.toolSearchPatchPath,
    paths.chartBindPatchPath,
  ];
  return order.filter(Boolean).flatMap((p) => ["--patch", p]);
}

export class DshBridge {
  #client = null;
  #subscription = null;
  #ready = false;
  #shuttingDown = false;
  #restarts = 0;
  #onEvent = () => {};
  #provider;
  #model;
  #cwd;
  #mcpPatchPath;
  #skillsPatchPath;
  #presetsPatchPath;
  #permissionsPatchPath;
  #toolSearchPatchPath;
  #chartBindPatchPath;
  #agentPreset;
  #env;
  // Preset roster cache, per child generation: null until the first successful
  // `presets/list` of the current child, cleared on every (re)spawn so a
  // restart (which may carry a different profile composition) re-reads it.
  #presetCache = null;
  // True while a restart() is in flight (shutdown → spawn → initialize). A
  // second restart (e.g. a set_model WS call arriving mid-restart) is rejected
  // with a restart-in-progress error rather than racing the spawn ladder.
  #restarting = false;
  #generation = 0;

  constructor({ onEvent, provider, model, cwd, mcpPatchPath, skillsPatchPath, presetsPatchPath, permissionsPatchPath, toolSearchPatchPath, chartBindPatchPath, agentPreset, env } = {}) {
    if (onEvent) this.#onEvent = onEvent;
    this.#provider = provider || "deepseek-official";
    this.#model = model || "deepseek-v4-flash";
    this.#cwd = cwd || process.cwd();
    this.#mcpPatchPath = mcpPatchPath || null;
    this.#skillsPatchPath = skillsPatchPath || null;
    this.#presetsPatchPath = presetsPatchPath || null;
    this.#permissionsPatchPath = permissionsPatchPath || null;
    this.#toolSearchPatchPath = toolSearchPatchPath || null;
    this.#chartBindPatchPath = chartBindPatchPath || null;
    this.#agentPreset = agentPreset || null;
    // When provided, the dsh child is spawned with this env instead of the
    // inherited process env — used to scrub upstream API keys (LLM_API_KEY /
    // LITELLM_API_KEY) so dsh-credentials-local's .credentials.yaml is the
    // winning resolution layer and a rotated key reaches the next request
    // without a restart (design D3). The parent keeps its own process.env copy
    // for its server-side consumers (documents RAG, LiteLLM cookie login).
    this.#env = env;
  }

  // Spawn the runtime, perform the initialize handshake, subscribe to
  // notifications, and start the fan-out pump. Idempotent while live.
  async start() {
    if (this.#client && this.#ready) return;
    return this.#spawn();
  }

  async #spawn() {
    // Build CLI args: profile + optional patch overlays (dsh-profile generators).
    // The flag order is load-bearing (see patchArgs).
    const args = ["--profile", PROFILE, ...patchArgs(this.#patchPaths())];
    // Which provider/model this generation was spawned with: a restart carries
    // the values current at spawn time, and a wrong one here is the difference
    // between a working turn and "no API key for provider route" — worth one
    // line in the log rather than a debugging session.
    console.log(`[dsh-bridge] spawn generation=${this.#generation} provider=${this.#provider} model=${this.#model} cwd=${this.#cwd}`);
    const client = new HarnessClient({
      command: COMMAND,
      args,
      cwd: this.#cwd,
      env: this.#env,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    client.start();
    // Retry the initialize handshake — it may race the async adapter
    // registration (see INIT_RETRIES). Only the "no adapter" race is retried;
    // other failures throw immediately. The deepseek-official fallback path
    // (no provider route needed) never races.
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await client.initialize({
          cwd: this.#cwd,
          provider: this.#provider,
          model: this.#model,
          ...(this.#agentPreset ? { agentPreset: this.#agentPreset } : {}),
        });
        break;
      } catch (e) {
        if (!/no adapter registered for provider/.test(e?.message || "") || attempt >= INIT_RETRIES) throw e;
        if (attempt === 0)
          console.warn(`[dsh-bridge] initialize racing adapter registration; retrying...`);
        await sleep(500);
      }
    }
    this.#client = client;
    this.#ready = true;
    // Fresh child = fresh roster: the preset cache is per generation.
    this.#presetCache = null;
    this.#subscription = client.subscribe();
    const generation = ++this.#generation;
    this.#pump(generation);
    try { this.#onEvent({ method: "bridge.ready", params: {} }); } catch { /* host callback best-effort */ }
    return res;
  }

  // The agent-preset roster the running child composes (`presets/list` on the
  // preset bridge). Cached per child generation — the roster only changes when
  // the child (or a preset file on disk) does, and a restart clears it. An
  // empty array also covers a deployment that composes no roster: the bridge
  // answers `[]` and callers render no picker.
  async listPresets() {
    this.#requireReady();
    if (!this.#presetCache) {
      this.#presetCache = await this.#client.request("presets/list", {});
    }
    return this.#presetCache;
  }

  // The permission preset roster + the session's effective preset
  // (`permissions/list` on the permission bridge). Deliberately NOT cached:
  // unlike the static preset roster, the payload carries the live `current`,
  // and every call is a rare, user-triggered refresh. After a restart the
  // fresh child answers with the deployment default — the honest post-restart
  // value the strip should show.
  async listPermissionPresets(sessionId) {
    this.#requireReady();
    return this.#client.request("permissions/list", sessionId ? { sessionId } : {});
  }

  // Switch the live session's permission preset (`permissions/set`). No child
  // restart — the runtime appends the durable `permission/preset` session
  // event and writes the sandbox/approval knobs; the event flows back through
  // the pump so every client corrects its view.
  async setPermissionPreset(sessionId, name) {
    this.#requireReady();
    return this.#client.request("permissions/set", { sessionId, name });
  }

  // Drain notifications until the runtime dies; a rejection (TransportClosed)
  // from subscription.next() is the exit signal — HarnessClient fails all
  // subscriptions when the child exits.
  async #pump(generation) {
    while (generation === this.#generation && this.#client && this.#ready) {
      let notif;
      try {
        notif = await this.#subscription.next();
      } catch {
        if (generation !== this.#generation || this.#shuttingDown) return;
        // Child died mid-pump. Signal the host so a turn in flight is aborted
        // (error + done) rather than wedging on isStreaming=true; then restart.
        try { this.#onEvent({ method: "_bridge_crash", params: {} }); } catch {}
        await this.#onExit();
        return;
      }
      if (generation !== this.#generation) return;
      try {
        this.#onEvent(notif);
      } catch (e) {
        console.error("[dsh-bridge] onEvent error:", e?.message || e);
      }
    }
  }

  // Unexpected-exit → restart-with-backoff (exponential, 30s ceiling, max
  // retries). Reset on a successful re-init. No-op during shutdown.
  async #onExit() {
    this.#ready = false;
    this.#client = null;
    if (this.#shuttingDown || this.#restarting) return;
    // Own unexpected-exit recovery so an explicit restart cannot race the
    // backoff ladder (or two pump exits cannot start two ladders).
    this.#restarting = true;
    try {
      // Signal the host so an in-flight turn (isStreaming wedged true) gets
      // error+done and the UI unwedges; the runtime is gone and won't emit
      // session.status idle itself. (Task 2.4 child-crash-mid-turn)
      try { this.#onEvent({ method: "bridge.exit" }); } catch { /* host callback best-effort */ }
      while (this.#restarts < MAX_RESTARTS) {
        const delay = Math.min(1000 * 2 ** this.#restarts, 30_000);
        this.#restarts += 1;
        console.warn(
          `[dsh-bridge] runtime exited; restarting in ${delay}ms (attempt ${this.#restarts}/${MAX_RESTARTS})`,
        );
        await sleep(delay);
        if (this.#shuttingDown) return;
        try {
          await this.#spawn();
          this.#restarts = 0;
          return;
        } catch (e) {
          console.error("[dsh-bridge] restart failed:", e?.message || e);
        }
      }
      console.error(`[dsh-bridge] gave up after ${MAX_RESTARTS} restarts`);
    } finally {
      this.#restarting = false;
    }
  }

  // Queue one prompt; returns the durable message id (fast — the turn plays
  // out as notifications, not as this request's result).
  async prompt(sessionId, contentBlocks) {
    this.#requireReady();
    return this.#client.prompt(sessionId, contentBlocks);
  }

  // Best-effort delete of a persisted dsh session. dsh has no documented
  // session-delete RPC in 0.0.1-rc.1; we send `session/delete` and swallow
  // "method not found" so a non-supporting runtime just logs a warning and the
  // host-side SQLite/file cleanup is the winning delete.
  async deleteSession(sessionId) {
    if (!sessionId) return false;
    if (!this.#ready || !this.#client) return false;
    try {
      await this.#client.request("session/delete", { sessionId });
      return true;
    } catch (err) {
      console.warn(`[dsh] session/delete for ${sessionId} failed (ignored): ${err.message}`);
      return false;
    }
  }

  // Re-initialize the child with a new provider/model/cwd/preset/patch. dsh
  // bakes all of these into the `initialize` handshake and exposes no stock
  // `setModel`/`setCwd`/reload RPC, so a live model switch, a workspace
  // switch, an agent-preset switch (blank sessions only — a session with
  // turns cannot recompose), OR an MCP add/remove (Task 4.5) means a fresh
  // child.
  // ponytail: this drops the child's in-memory session state (v1 ceiling); a
  // non-disruptive switch needs a custom dsh RPC.
  async restart({ provider, model, cwd, mcpPatchPath, agentPreset } = {}) {
    if (this.#restarting) {
      throw new Error("dsh restart already in progress");
    }
    this.#restarting = true;
    try {
      try { this.#onEvent({ method: "bridge.exit", params: { reason: "restart" } }); } catch { /* host callback best-effort */ }
      await this.shutdown();
      this.#shuttingDown = false;
      this.#restarts = 0;
      if (provider) this.#provider = provider;
      if (model) this.#model = model;
      // Stored on the instance, so the unexpected-exit backoff path respawns
      // in the switched directory rather than reverting to the startup one.
      if (cwd) this.#cwd = cwd;
      if (mcpPatchPath !== undefined) this.#mcpPatchPath = mcpPatchPath;
      if (agentPreset) this.#agentPreset = agentPreset;
      return await this.#spawn();
    } finally {
      this.#restarting = false;
    }
  }

  getCwd() {
    return this.#cwd;
  }

  // The overlay paths this instance spawns with, as patchArgs expects them.
  #patchPaths() {
    return {
      mcpPatchPath: this.#mcpPatchPath,
      skillsPatchPath: this.#skillsPatchPath,
      presetsPatchPath: this.#presetsPatchPath,
      permissionsPatchPath: this.#permissionsPatchPath,
      toolSearchPatchPath: this.#toolSearchPatchPath,
      chartBindPatchPath: this.#chartBindPatchPath,
    };
  }

  // The mcp.patch.yml this child was spawned watching (null when booted with
  // zero MCP servers). dshUpdateMcp needs it to tell "cordis is watching the
  // file we just rewrote" (HMR works) from "the child never loaded this patch"
  // (HMR is a silent no-op — a restart with the path is required).
  getMcpPatch() {
    return this.#mcpPatchPath;
  }

  #requireReady() {
    if (!this.#ready || !this.#client) {
      throw new TransportClosedError("dsh runtime not ready");
    }
  }

  isReady() {
    return this.#ready;
  }

  // Terminate: best-effort protocol `shutdown` then the close ladder.
  async shutdown() {
    this.#shuttingDown = true;
    this.#ready = false;
    this.#generation += 1;
    try { this.#subscription?.close(); } catch { /* closing a dead sub is fine */ }
    const client = this.#client;
    this.#client = null;
    try { await client?.close(); } catch (e) {
      console.error("[dsh-bridge] close error:", e?.message || e);
    }
  }
}

// Self-check: spawn, initialize, close. Proves the command, framing, and
// handshake without an LLM round-trip (Task 1.5 adds a real prompt).
// Usage: node dsh-bridge.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const b = new DshBridge();
  let serverInfo;
  try {
    serverInfo = await b.start();
    const name = serverInfo?.serverInfo?.name;
    if (name !== "deepseek-harness-sdk-runtime") {
      throw new Error(`unexpected serverInfo: ${JSON.stringify(serverInfo)}`);
    }
    console.log("OK initialize —", name);
  } catch (e) {
    console.error("FAIL:", e?.constructor?.name, e?.message || e);
    process.exitCode = 1;
  } finally {
    await b.shutdown();
    console.log("closed");
  }
}
