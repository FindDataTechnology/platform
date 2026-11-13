## 1. Scaffolding & spikes

- [x] 1.1 Add `electron` and `electron-builder` to devDependencies; add `npm start:electron` script
- [x] 1.2 Spike: run `pi --mode rpc` locally and confirm whether it loads our `mcp.json` natively (or how to pass MCP config); record the answer in `design.md` Open Questions
- [x] 1.3 Spike: read `docs/rpc.md` fully + the SDK's `src/modes/rpc/rpc-client.ts`; catalog exact RPC event names for text/thinking/tool/skill/done to drive the event mapper
- [x] 1.4 Make store paths overridable: add `PLATFORM_DATA_DIR` env resolution to `db.js`, `documents.js`, `chat-history.js`, `collections.js`, `cron.js` (default to current relative dirs in dev)
- [x] 1.5 Verify `npm start` still works after the path refactor (regression check)

## 2. Supervisor core (Phase 1)

- [x] 2.1 Create `electron/main.js`: Electron app lifecycle, single-instance lock, hidden `BrowserWindow`
- [x] 2.2 Create `electron/supervisor/descriptors.js`: descriptor schema + the four default descriptors (`server.js`, `pi-agent`, `litellm`, `openconnector`)
- [x] 2.3 Create `electron/supervisor/process.js`: spawn child via bundled Node, env injection, pid tracking, graceful + forceful kill
- [x] 2.4 Create `electron/supervisor/health.js`: HTTP probe + RPC-ping probe on an interval; state machine (starting / healthy / unhealthy / stopped)
- [x] 2.5 Create `electron/supervisor/ports.js`: find a free localhost port; assign + track per server
- [x] 2.6 Create `electron/supervisor/lifecycle.js`: ordered startup (wait on deps), reverse-ordered shutdown, restart-with-backoff, suppress restart during shutdown
- [x] 2.7 Create `electron/supervisor/logs.js`: per-server stdout/stderr ring buffer
- [x] 2.8 Create `electron/supervisor/status.js` (IPC): expose server status to the renderer
- [x] 2.9 Wire `main.js`: on ready run the startup sequence; open the window loading `http://localhost:<server.js port>` only after `server.js` health is green; on `before-quit` run shutdown
- [x] 2.10 Milestone: app launches, window shows the UI, `server.js` is supervised & restartable (agent still in-process at this phase)

## 3. pi-agent RPC extraction (Phase 2)

> **Note (post-spike revision):** the spike (1.2) confirmed the SDK has no native
> MCP support, so `pi --mode rpc` cannot carry our MCP tools. Per `design.md`
> (Decision D2, updated), Phase 2 now uses a **custom agent-server wrapper**
> (a separate process built around `createAgentSession` + the existing
> `mcp-bridge.js`, exposing the WS protocol over a localhost port) instead of
> `pi --mode rpc` + a stdio bridge. The tasks below reflect the original plan
> and will be rewritten to the wrapper approach when Phase 2 starts.

- [ ] 3.1 Create `electron/supervisor/pi-bridge.js`: a `net.Server` piping a localhost socket to the `pi --mode rpc` child's stdin/stdout (JSONL, split on `\n` only - never `readline`)
- [ ] 3.2 Register the `pi-agent` descriptor as `stdio-rpc`; supervisor starts bridge + child; health = correlated RPC ping
- [ ] 3.3 Create `electron/rpc-client.js` (used by `server.js`): JSON-RPC over the bridge socket, `\n` framing, correlation ids; model on the SDK's `rpc-client.ts`
- [ ] 3.4 In `server.js`, replace in-process `createAgentSession` usage with the RPC client; send `prompt` via RPC; subscribe to RPC events
- [ ] 3.5 Build the event mapper: RPC events -> existing WS events (`text`, `thinking`, `tool_start`/`update`/`end`, `skill_use`, `done`); verify against `chat-streaming` / `tool-use-rendering` specs
- [ ] 3.6 Move MCP registration into pi-agent: pass `mcp.json` / MCP config to `pi --mode rpc` per the 1.2 spike result; remove in-process `mcp-bridge` registration from `server.js` startup (keep the module for config building)
- [ ] 3.7 Move provider + API-key wiring into pi-agent: pass `--provider` / `--model` + keys via env/settings; remove `authStorage.setRuntimeApiKey` and litellm extension registration from `server.js`
- [ ] 3.8 Model selection via RPC: `list_models` WS -> RPC `get_available_models`; `set_model` -> RPC `set_model`; emit `models` / `current_model` / `model_changed` as today (preserve `model-selection` spec)
- [ ] 3.9 Retire manual `/skill:` body expansion in `server.js` (RPC expands it); keep the `skill_use` WS broadcast (driven by the RPC skill event or prefix detection)
- [ ] 3.10 Verify `chat-history`: user turn appended on `prompt`, assistant text appended on `done` (from the RPC stream) - behavior unchanged
- [ ] 3.11 Milestone: agent runs as a separate process; full browser-facing e2e (chat, model switch, skills, tools) green; killing `pi-agent` confirms it restarts without taking down the window

## 4. Config & packaging (Phase 3)

- [x] 4.1 Create `electron/config/settings.js`: read/write a JSON settings file in `app.getPath('userData')` (litellm URL/key, openconnector URL/tokens, default model, provider keys)
- [x] 4.2 Supervisor reads settings and passes them as env to children; `.env` remains in dev (`npm start`)
- [x] 4.3 Resolve `public/` via `app.getAppPath()`; ensure stores + SQLite land in `userData` (via `PLATFORM_DATA_DIR`) in packaged mode
- [x] 4.4 Bundle a standalone Node binary (mac arm64/x64, win x64) as `extraResources`; supervisor spawns children with it; verify `better-sqlite3` / `tree-sitter` load with no rebuild
- [x] 4.5 Add `electron-builder` config (mac dmg, win nsis); include `public/`, `server.js` + server modules, bundled Node, `skills/`
- [x] 4.6 Confirm single-instance lock + dynamic-port collision handling
- [x] 4.7 Build + smoke-test the distributable `.app` (mac) and `.exe` (win): launch, chat, model switch, documents, openconnector panel (if configured)
- [ ] 4.8 macOS signing + notarization pass for the embedded Node binary

## 5. Sidecar bundling (Phase 4, optional)

- [ ] 5.1 Bundle OpenConnector (Node 22+) as a spawned sidecar descriptor; supervisor starts it on a free port; set `OPENCONNECTOR_BASE_URL` to it
- [ ] 5.2 Bundle LiteLLM via `python-build-standalone` + `litellm[proxy]` as a spawned sidecar; supervisor starts it on a free port; set `LITELLM_BASE_URL` to it
- [ ] 5.3 Health-check + restart for bundled sidecars (same lifecycle as the others)
- [ ] 5.4 Verify app size and a fully self-contained launch (no external services required)

## 6. Verification & docs

- [ ] 6.1 Add an e2e (Playwright) test: Electron launch -> chat round-trip -> tool render -> model switch
- [ ] 6.2 Add an e2e test: kill the `pi-agent` process -> confirm restart + UI survives
- [x] 6.3 Update `CLAUDE.md` with Electron build/run instructions and the supervisor architecture
- [ ] 6.4 Review the change against `desktop-supervisor` specs; ensure implementation matches requirements
