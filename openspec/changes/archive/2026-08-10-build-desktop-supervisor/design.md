## Context

Today the Platform is a single Node process (`server.js`: Express + `ws`) that holds **one in-process pi agent session** and serves the vanilla-JS frontend from `public/`. LiteLLM (Python, BerriAI/litellm) and OpenConnector (Node 22+, oomol-lab/open-connector) are external services already wired via env (`LITELLM_BASE_URL`, `OPENCONNECTOR_*`). Native addons `better-sqlite3` / `tree-sitter` / `fsevents` are present. Stores sit on disk relative to CWD; config is `.env`; the server binds `localhost` with no auth and one shared session - fine for a single-user desktop, wrong for phones/hosting.

The `@earendil-works/pi-coding-agent` SDK ships a first-class headless mode: `pi --mode rpc` (`dist/rpc-entry.js`), documented at `docs/rpc.md`. It speaks **JSON-RPC over stdio** and covers the full agent surface - `prompt` / `steer` / `follow_up` / `abort`, `new_session` / `get_state` / `get_messages`, `set_model` / `cycle_model` / `get_available_models` - and expands `/skill:name` and `/template` itself, with `--session-dir` persistence and `--provider` / `--model` selection. A reference client exists at `src/modes/rpc/rpc-client.ts`. The doc warns: **do not parse the stream with Node `readline`** (it splits on `U+2028`/`U+2029`, valid inside JSON strings) - split on `\n` only.

Project constraints to preserve (from `CLAUDE.md`): graceful degradation for every external dependency; tokens never reach the browser; atomic persistence; event-driven UI via `broadcast()`.

## Goals / Non-Goals

**Goals:**
- One double-clickable Electron app (macOS + Windows) that runs the whole stack with no Node install, no terminal, no `.env` editing.
- A supervisor (Electron main process) that treats four servers - `server.js`, `pi-agent`, LiteLLM, OpenConnector - uniformly: start, health-check, restart, stop, inspect.
- pi-agent runs as an **independent process** (SDK `--mode rpc`), isolated from `server.js` and the window.
- **No native-module rebuild**: child servers run on a bundled standalone Node (standard ABI); Electron main stays pure JS.
- Preserve every browser-facing contract (WS protocol, REST routes) and the `npm start` dev workflow.

**Non-Goals:**
- iOS/Android thin clients and a hosted/multi-tenant backend (separate changes; desktop is single-user localhost).
- Bundling LiteLLM/OpenConnector into v1 (phased - v1 external; later phases bundle).
- Frontend rewrite (minimal changes only).
- Linux packaging (config-ready, not a v1 deliverable).

## Decisions

**D1 - Electron main = supervisor only, no app logic.** The main process spawns/monitors children and never imports `server.js` or touches native addons. *Why over importing `server.js` in-process:* isolation (agent crash can't kill the UI), uniform lifecycle, and zero native-rebuild coupling. *Alternative rejected:* in-process import (simpler, but couples lifecycle, requires `electron-rebuild`, and an agent crash takes down the window).

**D2 - pi-agent extracted to a custom agent-server wrapper process.** The agent runs in its own process, built as a thin server around `createAgentSession` + the existing `mcp-bridge.js`, exposing the WS protocol over a localhost port. *Why (spike-confirmed):* the SDK's `pi --mode rpc` headless mode was the original plan, but the SDK has **no native MCP support** (confirmed by source grep + `CLAUDE.md`: "The pi SDK has no native MCP support"). MCP is a Platform-level custom layer (`mcp-bridge.js`) that wraps MCP tools as `ToolDefinition`s and injects them into `createAgentSession({ tools })`. The `pi --mode rpc` subprocess builds its own session and **cannot receive our injected MCP tools** via the RPC protocol - so using it would drop OpenConnector actions and all custom MCP servers. The custom wrapper preserves MCP (same `mcp-bridge.js` code, just in a separate process) while still achieving agent-as-independent-process. *Alternative rejected:* `pi --mode rpc` (loses MCP - ruled out by the spike). The wrapper reuses `createAgentSession` exactly as `server.js` does today, so it is not duplicated SDK work - it is `server.js`'s existing agent code relocated to its own process.

**D3 - Supervisor owns pi-agent's stdio via a local TCP/WS bridge.** pi-agent is stdio JSON-RPC, not a port. To "start and inspect" it uniformly alongside the HTTP servers, the supervisor runs a small `net.Server` that pipes a localhost socket to the child's stdin/stdout, so both the supervisor (RPC-ping health) and `server.js` (RPC client) talk to pi-agent over a socket. *Why over (a) server.js spawning pi-agent as a grandchild:* that breaks uniform supervision (pi-agent wouldn't be directly inspectable). *Why over (c) a separate 5th adapter process:* extra process for no gain; the bridge is a few dozen lines inside the supervisor.

**D4 - Bundle a standalone Node binary for child servers, not `ELECTRON_RUN_AS_NODE`.** `server.js`, OpenConnector, and pi-agent all spawn under a bundled Node whose major/minor matches the install-time ABI of `better-sqlite3`/`tree-sitter` - so native addons load with **no rebuild**. Electron main stays pure JS. *Why over `ELECTRON_RUN_AS_NODE` + `electron-rebuild`:* that ties child ABI to Electron's bundled Node (still requires rebuild) and couples the child Node version to the Electron release. *Trade-off:* +~40 MB Node binary per platform.

**D5 - `server.js` becomes an RPC client + WS bridge.** It maps pi-agent RPC events onto the existing WS protocol (`text` / `thinking` / `tool_*` / `skill_use` / `done` / `models` / `current_model` / `model_changed`), preserving `chat-streaming`, `model-selection`, `skill-invocation`, and `tool-use-rendering` specs. MCP registration, provider/API-key wiring, and model selection move into pi-agent (it owns the session); `server.js` proxies model-selection RPC to the browser. `chat-history` append on `done` is unchanged. Documents/collections/OpenConnector REST stay in `server.js`.

**D6 - Store paths land in `app.getPath('userData')` when packaged; relative paths in dev.** The macOS app bundle is read-only; `userData` is per-user, writable, and survives updates. Paths are made overridable via one env var (e.g. `PLATFORM_DATA_DIR`) consumed by `db.js` / `documents.js` / `chat-history.js` / `collections.js` / `cron.js`, so both modes work without scattered branching. `public/` resolves via `app.getAppPath()`.

**D7 - Config via a `userData` settings file, not `.env`.** The supervisor reads a JSON settings file and passes values to children as env. `.env` remains for dev. Graceful degradation is preserved (unset = feature disabled, server still starts).

**D8 - Ordered startup, reverse-ordered shutdown.** Startup: health-check external LiteLLM/OpenConnector -> start pi-agent (wait for RPC ready) -> start `server.js` (wait for HTTP listening) -> open `BrowserWindow`. Shutdown: close window -> stop `server.js` -> stop pi-agent -> (bundled sidecars in later phases). *Why:* `server.js` depends on pi-agent (RPC) and on LiteLLM/OC (env URLs).

**D9 - Dynamic free ports for spawned servers.** The supervisor assigns a free localhost port to each spawned port-speaking server at launch and passes resolved sibling URLs into each child's env. External LiteLLM/OC use user-configured URLs (not assigned). *Why over fixed ports:* avoids collisions with the user's existing `:3000`/`:4000`.

**D10 - Sidecar bundling phased.** v1: LiteLLM + OC external (supervisor health-checks, does not spawn). Phase 2: bundle OpenConnector (Node) as a spawned sidecar. Phase 3: bundle LiteLLM (Python via `python-build-standalone`) as a spawned sidecar. *Why phased:* keeps v1 achievable; OC is the natural first bundle (same runtime); LiteLLM Python is heaviest, last.

## Risks / Trade-offs

- **[CONFIRMED - pi-agent RPC mode cannot carry MCP]** -> Spike (task 1.2) confirmed the SDK has no native MCP support; MCP is a Platform custom layer injected at `createAgentSession`. `pi --mode rpc` builds its own session and cannot receive our MCP `ToolDefinition`s, so it would drop OpenConnector actions + custom MCP servers. **Resolution: Phase 2 uses the custom agent-server wrapper (D2), not `pi --mode rpc`.** MCP registration stays via `mcp-bridge.js` inside the wrapper process - unchanged from today.
- **[RPC event shapes may not map 1:1 to existing WS events]** -> Build a tested event-mapper; canonicalize against `rpc-client.ts` and `docs/rpc.md`. The browser-facing specs pin the contract - map to those.
- **[Bundled Node ABI mismatch with native addons]** -> Pin bundled Node major/minor to the install-time Node; verify `better-sqlite3`/`tree-sitter` load per platform in CI.
- **[App size]** -> Electron (~150 MB) + bundled Node (~40 MB) + deps; Phase 3 Python adds ~100 MB. Document per phase; acceptable for desktop.
- **[pi-agent restart loses in-flight conversation]** -> Mitigate via `--session-dir` persistence (RPC mode supports it); `chat-history.js` already persists turns. A live in-flight turn may be lost on crash - acceptable, agent restarts.
- **[macOS notarization with embedded Node/Python binaries]** -> Sign + notarize embedded binaries; `python-build-standalone` is generally notarization-friendly; verify in a release build.
- **[stdio bridge single-client]** -> The bridge serves `server.js` as the single RPC client in v1; multiplex later if needed.
- **[JSONL framing gotcha]** -> The RPC parser MUST split on `\n` only, never use `readline` (splits on `U+2028`/`U+2029`). Use the SDK's `rpc-client.ts` framing or a custom `\n` splitter.

## Migration Plan

- **Phase 0 - scaffolding:** add `electron` + `electron-builder` deps; create `electron/main.js` + supervisor skeleton; make store paths overridable (dev still works via `npm start`). No behavior change for existing users.
- **Phase 1 - supervisor core:** descriptors, spawn, health, restart, lifecycle, port manager, window-open-after-listen. `server.js` still uses the in-process agent (supervised as a child, agent not yet extracted). *Milestone: app launches, window shows UI, `server.js` supervised.*
- **Phase 2 - pi-agent RPC extraction:** stdio bridge, RPC client in `server.js`, event mapping, move MCP/provider/model-selection, retire manual skill expansion. *Milestone: agent runs as a separate process; all browser-facing e2e green.*
- **Phase 3 - config + packaging:** `userData` settings, `electron-builder` mac+win, bundle Node, first distributable `.app`/`.exe`.
- **Phase 4 (optional):** bundle OpenConnector sidecar, then LiteLLM Python sidecar.
- **Rollback:** each phase lives behind the supervisor; `npm start` (non-Electron) remains the fallback dev path. Phases are independently shippable.

## Open Questions

- ~~Does `pi --mode rpc` load our `mcp.json` natively?~~ **Resolved (task 1.2):** No - the SDK has no native MCP support; MCP is a Platform custom layer. Phase 2 uses the custom wrapper (D2), preserving MCP via `mcp-bridge.js` in-process within the wrapper. `pi --mode rpc` is ruled out.
- Exact RPC event names for tool/thinking/skill - confirm against `rpc-client.ts` / `docs/rpc.md` before building the mapper.
- Dynamic vs fixed ports for v1 (decision: dynamic for spawned children, external URLs for LiteLLM/OC).
- Settings UI in v1, or settings file only? (Default: file only; UI later.)
