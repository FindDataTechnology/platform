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
import { dshClientRuntime } from "./lib/dsh-client-launch.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the dsh runtime command (win-install-smoke 2026-10-08: a packaged
// install ships no global `dsh` on PATH — spawn dsh ENOENT crash-looped the
// backend until the binary entered the dependency closure). Resolution order:
//   1. DSH_BIN env — explicit override, highest precedence.
//   2. Bundled runtime: this file lives at <app>/dsh-bridge.js in ALL layouts
//      (repo tree, asar:false resources/app/), so the sibling
//      node_modules/@deepseek-ai/dsh/lib/bin.js is the packaged binary entry.
//      Run it with process.execPath — under Electron's bundled-Node children
//      that IS the bundled node (server.js is its child), keeping the
//      native-addon ABI story intact and dodging Windows .bin shim issues
//      (no-extension `dsh` is not spawnable there; .cmd shims would be).
//   3. Bare `dsh` — dev machines with the global install.
const BRIDGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DSH_ENTRY = path.join(BRIDGE_ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

let COMMAND = process.env.DSH_BIN || null;
let COMMAND_ARGS = [];
if (!COMMAND && existsSync(BUNDLED_DSH_ENTRY)) {
  COMMAND = process.execPath;
  COMMAND_ARGS = [BUNDLED_DSH_ENTRY];
} else if (!COMMAND) {
  COMMAND = "dsh";
}
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
// makes every overlay additive and individually optional. The preset overlay
// MUST come before the MCP overlay — the preset bridge's plugin start installs
// the registration-time tool-scope shadow (add-tool-scope-register-shadow),
// which misses dsh-mcp-client's first generation if it loads first — and the
// row-swapping overlays MUST come after the row they disable: permissions after
// presets (swaps the preset bridge), user-questions after permissions (swaps
// that row), plugin-supply after user-questions (swaps THAT row). The
// insert-only overlays (tool-search, chart-bind, save-library) touch no
// existing row. Mirrors agent-runner/compose.js's ordering.
export function patchArgs(paths = {}) {
  const order = [
    paths.presetsPatchPath,
    paths.mcpPatchPath,
    paths.skillsPatchPath,
    paths.permissionsPatchPath,
    paths.toolSearchPatchPath,
    paths.chartBindPatchPath,
    paths.userQuestionsPatchPath,
    paths.pluginSupplyPatchPath,
    paths.saveLibraryPatchPath,
  ];
  return order.filter(Boolean).flatMap((p) => ["--patch", p]);
}

// Classify a `preset/set` failure (add-cell-session-persona D2): the
// live-session refusal is a CONTRACT, not a string coincidence — the presets
// patch bridge's spec (dsh-runtime-bridge, "Per-session preset selection parks
// until the session exists") pins the "persona is creation-time composition"
// wording, so matching it is contract-backed. An UNMATCHED error must never be
// misread as a refusal: it returns refused:false and the caller takes the
// legacy restart fallback with the error recorded.
export function classifyPresetSetError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/persona is creation-time composition|already has a live agent/i.test(msg)) {
    return { refused: true };
  }
  return { refused: false, error: err instanceof Error ? err : new Error(msg || "preset/set failed") };
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
  #effort;
  #cwd;
  #mcpPatchPath;
  #skillsPatchPath;
  #presetsPatchPath;
  #permissionsPatchPath;
  #toolSearchPatchPath;
  #chartBindPatchPath;
  #userQuestionsPatchPath;
  #pluginSupplyPatchPath;
  #saveLibraryPatchPath;
  #agentPreset;
  #env;
  // Preset roster cache, per child generation: null until the first successful
  // `presets/list` of the current child, cleared on every (re)spawn so a
  // restart (which may carry a different profile composition) re-reads it.
  #presetCache = null;
  // Sessions whose persona was PARKED on this child generation
  // (add-cell-session-persona): sessionId → presetId, recorded after a
  // successful `preset/set`. Same generation discipline as #presetCache —
  // a (re)spawn empties it, because the new child holds no live agents and
  // every persisted session composes from a fresh park (or the runtime
  // default) at its next prompt. `deleteSession` drops the entry with the
  // session (fleet rounds rotate child ids, so stale entries are pure noise).
  #preparedPresets = new Map();
  // True while a restart() is in flight (shutdown → spawn → initialize). A
  // second restart (e.g. a set_model WS call arriving mid-restart) is rejected
  // with a restart-in-progress error rather than racing the spawn ladder.
  #restarting = false;
  #generation = 0;

  constructor({ onEvent, provider, model, effort, cwd, mcpPatchPath, skillsPatchPath, presetsPatchPath, permissionsPatchPath, toolSearchPatchPath, chartBindPatchPath, userQuestionsPatchPath, pluginSupplyPatchPath, saveLibraryPatchPath, agentPreset, env } = {}) {
    if (onEvent) this.#onEvent = onEvent;
    this.#provider = provider || "deepseek-official";
    this.#model = model || "deepseek-v4-flash";
    // Thinking depth baked into the initialize handshake (add-agent-config-
    // dims): runtimes without the live model/set RPC can only take the effort
    // at initialize, so it must survive restarts like provider/model do.
    this.#effort = effort || null;
    this.#cwd = cwd || process.cwd();
    this.#mcpPatchPath = mcpPatchPath || null;
    this.#skillsPatchPath = skillsPatchPath || null;
    this.#presetsPatchPath = presetsPatchPath || null;
    this.#permissionsPatchPath = permissionsPatchPath || null;
    this.#toolSearchPatchPath = toolSearchPatchPath || null;
    this.#chartBindPatchPath = chartBindPatchPath || null;
    this.#userQuestionsPatchPath = userQuestionsPatchPath || null;
    this.#pluginSupplyPatchPath = pluginSupplyPatchPath || null;
    this.#saveLibraryPatchPath = saveLibraryPatchPath || null;
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

  // ── Live runtime control (live-runtime-control) ────────────────────────────
  // Custom bridge RPCs over the same stdio transport. `#liveMethods` is probed
  // once per spawn via platform/capabilities; an older child (template without
  // the methods) answers unknown-method and the set stays empty — callers then
  // keep the legacy restart-based behavior.
  #liveMethods = new Set();

  hasLiveMethod(method) {
    return this.#liveMethods.has(method);
  }

  async #probeLiveMethods(client) {
    this.#liveMethods = new Set();
    try {
      const res = await client.request("platform/capabilities");
      if (Array.isArray(res?.methods)) {
        for (const m of res.methods) if (typeof m === "string") this.#liveMethods.add(m);
      }
    } catch {
      /* older child — empty set is the degradation signal */
    }
  }

  // Flip the live model selection. `effort`: undefined = keep the selection's
  // current level, null = clear to the provider default, string = the level.
  // `sessionId` optional — omitted means process defaults for new sessions.
  async setModel({ provider, model, effort = undefined, sessionId = undefined }) {
    this.#requireReady();
    return this.#client.request("model/set", {
      provider,
      model,
      ...(effort !== undefined ? { reasoningEffort: effort ?? "" } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
  }

  // Abort a session's active turn natively (agent.cancel). The turn's close
  // still surfaces through the session.status idle → finishTurn path.
  async cancelSession(sessionId) {
    this.#requireReady();
    return this.#client.request("session/cancel", { sessionId });
  }

  // Flip a per-session MCP server gate (default-closed set declared at
  // initialize). Takes effect on the next tool call — no restart.
  async setToolGate({ sessionId, server, enabled }) {
    this.#requireReady();
    return this.#client.request("tools/set", { sessionId, server, enabled });
  }

  // Whether this child generation accepts `preset/set` reads through the
  // existing hasLiveMethod("preset/set") probe — callers take the legacy
  // restart path when it answers false (add-cell-session-persona D2).

  // The preset this child generation already has parked for the session
  // (null = not parked here). The turn executor consults this before
  // prompting so a bound session is parked once per generation, not per turn.
  preparedPreset(sessionId) {
    return this.#preparedPresets.get(sessionId) ?? null;
  }

  // Park a per-session persona (add-cell-session-persona): parked-only
  // upstream — the composition mounts when the session is lazily created or
  // resumed; a LIVE session refuses with the contract message. A successful
  // park records the generation-local entry; a refusal must NOT (the live
  // session keeps its own composition and the caller falls back).
  async setPreset({ sessionId, presetId }) {
    this.#requireReady();
    await this.#client.request("preset/set", { sessionId, presetId });
    this.#preparedPresets.set(sessionId, presetId);
    return true;
  }

  async #spawn() {
    // Build CLI args: profile + optional patch overlays (dsh-profile generators).
    // The flag order is load-bearing (see patchArgs).
    const args = [...COMMAND_ARGS, "--profile", PROFILE, ...patchArgs(this.#patchPaths())];
    // Which provider/model this generation was spawned with: a restart carries
    // the values current at spawn time, and a wrong one here is the difference
    // between a working turn and "no API key for provider route" — worth one
    // line in the log rather than a debugging session.
    console.log(`[dsh-bridge] spawn generation=${this.#generation} provider=${this.#provider} model=${this.#model} cwd=${this.#cwd}`);
    const client = new HarnessClient(
      {},
      dshClientRuntime({
        command: COMMAND,
        args,
        cwd: this.#cwd,
        env: this.#env,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      }),
    );
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
          ...(this.#effort ? { reasoningEffort: this.#effort } : {}),
          ...(this.#agentPreset ? { agentPreset: this.#agentPreset } : {}),
          // Session-gated MCP servers (live-runtime-control): default-closed
          // per-session servers the child's tools/set gate enforces.
          sessionGatedMcp: ["websearch"],
        });
        break;
      } catch (e) {
        if (!/no adapter registered for provider/.test(e?.message || "") || attempt >= INIT_RETRIES) throw e;
        if (attempt === 0)
          console.warn(`[dsh-bridge] initialize racing adapter registration; retrying...`);
        await sleep(500);
      }
    }
    await this.#probeLiveMethods(client);
    this.#client = client;
    this.#ready = true;
    // Fresh child = fresh roster: the preset cache is per generation.
    this.#presetCache = null;
    // Fresh child = no live agents: every prepared-park entry died with the
    // old process; the next prompt re-parks (or composes the runtime default).
    this.#preparedPresets.clear();
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

  // Read the profile's whitelisted dsh bundle roster (`plugins/list`,
  // add-dsh-plugin-supply). The bridge answers an empty roster when the
  // deployment composes no plugin-manager service — the Plugins section then
  // renders "no bundles supplied" rather than erroring.
  async listPluginBundles() {
    this.#requireReady();
    return this.#client.request("plugins/list", {});
  }

  // Toggle one bundle LAYER (`plugins/set_enabled`). The child writes through
  // the plugin-manager service's own semantics (profile manifest bundles-list
  // edit + reload) and reports `application`: "applied" when the HMR reload
  // reconciled the live composition in place, "restart-required" when no HMR
  // is present (the caller then restarts this bridge through restart()), and
  // "failed"/"cancelled" with an error otherwise. Unknown bundles and
  // version-gate refusals throw → JSON-RPC error to the caller.
  async setPluginBundleEnabled(name, enabled) {
    this.#requireReady();
    return this.#client.request("plugins/set_enabled", { name, enabled });
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
      // The session is gone from this child generation — its prepared-park
      // entry is noise after this point (a deleted session is never resumed).
      this.#preparedPresets.delete(sessionId);
      return true;
    } catch (err) {
      console.warn(`[dsh] session/delete for ${sessionId} failed (ignored): ${err.message}`);
      return false;
    }
  }

  // Resolve or cancel a pending user-questions ask in the child
  // (add-user-questions). Returns the child's receipt — {accepted:true} or
  // {accepted:false, reason} for an unknown/already-resolved ask (that IS the
  // first-wins semantics). Throws only on transport/timeout failures.
  async answerUserQuestion({ sessionId, askId, answers = null, cancelled = false }) {
    this.#requireReady();
    return this.#client.request("userQuestions/answer", {
      sessionId,
      askId,
      ...(cancelled ? { cancelled: true } : { answers: answers ?? [] }),
    });
  }

  // Re-initialize the child with a new provider/model/cwd/preset/patch. dsh
  // bakes all of these into the `initialize` handshake and exposes no stock
  // `setModel`/`setCwd`/reload RPC, so a live model switch, a workspace
  // switch, an agent-preset switch (blank sessions only — a session with
  // turns cannot recompose), OR an MCP add/remove (Task 4.5) means a fresh
  // child.
  // ponytail: this drops the child's in-memory session state (v1 ceiling); a
  // non-disruptive switch needs a custom dsh RPC.
  async restart({ provider, model, effort, cwd, mcpPatchPath, agentPreset } = {}) {
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
      // effort rides restarts too (add-agent-config-dims): undefined = keep,
      // null = clear back to the deployment default.
      if (effort !== undefined) this.#effort = effort || null;
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
      userQuestionsPatchPath: this.#userQuestionsPatchPath,
      pluginSupplyPatchPath: this.#pluginSupplyPatchPath,
      saveLibraryPatchPath: this.#saveLibraryPatchPath,
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

  // A restart (credential delivery, preset switch, crash respawn) tears the
  // child down and re-initializes it, so isReady() is false for that whole
  // window even though the runtime is about to come back. A readiness gate that
  // only polls isReady() cannot tell "down and coming back" from "never
  // booted": it burns its budget and the round is lost (2026-11-08 live).
  isRestarting() {
    return this.#restarting === true;
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
