## Why

Today the Platform is a Node process started via `npm start` in a terminal, with LiteLLM and OpenConnector run as separate manual services. There is no single distributable app: end users must install Node, edit `.env`, run multiple processes, and open a browser. We want one double-clickable desktop app (Windows/macOS) that runs the entire stack itself. Treating each backend component as an independent, supervised process — and extracting the pi-agent into the SDK's documented headless RPC mode — gives process isolation (an agent crash no longer kills the UI), a uniform start/stop/inspect lifecycle, individual restartability, and a clean path to bundle sidecars later.

## What Changes

- Add an Electron desktop shell whose main process is a **process supervisor** (no app logic) that starts, health-checks, logs, restarts, and stops four independent servers: `server.js`, `pi-agent`, LiteLLM, and OpenConnector.
- **Extract pi-agent out of `server.js`** into its own process using the SDK's first-class `pi --mode rpc` JSON-RPC-over-stdio headless mode. `server.js` becomes an RPC client + WS bridge that maps RPC events onto the existing WS protocol.
- Supervisor owns pi-agent's stdio via a small local TCP/WS bridge so pi-agent is uniformly inspectable alongside the HTTP servers (honors "start and inspect all four").
- Bundle a standalone Node runtime for the child servers (`server.js`, OpenConnector, pi-agent) so native addons (`better-sqlite3`, `tree-sitter`, `fsevents`) run on their standard ABI — **no `electron-rebuild`** — and the Electron main process stays pure JS (`child_process` + HTTP only).
- Make `server.js`/`db.js` store and SQLite paths overridable: land in `app.getPath('userData')` when packaged, while current relative paths still work for `npm start` in dev.
- Replace `.env`-only config with a settings file in `userData` (end users cannot edit `.env`); the supervisor reads it and passes env to children. Graceful degradation is preserved.
- Move MCP tool registration, provider/API-key wiring, and model selection into the pi-agent process (it owns the session); `server.js` proxies model-selection RPC to the browser.
- Retire `server.js`'s manual `/skill:` body expansion (RPC mode expands skills itself); keep the `skill_use` UI event.
- Package with `electron-builder` for macOS + Windows.
- **Phased sidecar bundling**: v1 points at external LiteLLM/OpenConnector (the user's existing instances); later phases bundle OpenConnector (Node) and LiteLLM (Python) as supervised sidecars.
- **Out of scope**: iOS/Android thin clients and a hosted/multi-tenant backend (separate changes).

## Capabilities

### New Capabilities
- `desktop-supervisor`: orchestrates N independent backend servers as child processes — descriptor-driven spawn, health-check, restart policy, log capture, ordered startup/shutdown, and status inspection. Lives in the Electron main process.

### Modified Capabilities
<!-- Browser-facing contracts are intentionally preserved; only the backend implementation migrates behind the same WS/REST contract. MCP/provider/model-selection move into the pi-agent process but expose the same behavior, so no spec-level requirement changes. -->
- _(none)_

## Impact

- **New files**: `electron/main.js` (supervisor entry); `electron/supervisor/*` (server descriptors, health-checkers, port manager, pi-agent stdio→port bridge, lifecycle); `electron/rpc-client.js` (pi-agent JSON-RPC client used by `server.js`); `electron-builder` config.
- **Modified**: `server.js` (agent interaction → RPC client + WS bridge; store-path overrides; config source); `db.js`, `documents.js`, `chat-history.js`, `collections.js`, `cron.js` (store paths overridable); `mcp-bridge.js` (MCP config consumed by pi-agent instead of in-process registration); `public/app.js` (minimal — backend origin already configurable; optional supervisor status strip).
- **Dependencies**: add `electron`, `electron-builder`; bundle a standalone Node binary (per platform) as an app resource; optional `python-build-standalone` + LiteLLM for the Phase 3 sidecar.
- **Native addons**: run under the bundled Node (standard ABI), not Electron's — avoids the rebuild step.
- **Dev workflow**: `npm start` remains functional for non-Electron development.
