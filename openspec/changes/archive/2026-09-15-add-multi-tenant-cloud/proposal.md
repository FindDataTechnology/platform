## Why

The platform is architecturally single-tenant: one `server.js` process, one shared dsh runtime, one SQLite data dir serve every connected browser — PRODUCT.md's "personal assistant" positioning. The product direction is now a hosted multi-user cloud where users are **mutually isolated** (each user's chat history, documents, MCP servers, and skills are their own), while the same codebase keeps shipping as the packaged desktop app for local single-user use.

The key existing assets that make this a boundary-and-orchestration change rather than a rewrite: all writable state is already centralized behind `PLATFORM_DATA_DIR` (paths.js), `DSH_HOME`/`MCP_CONFIG_PATH` are env-driven, Logto login + forward-auth identity headers already work, and the Electron supervisor already runs "one server + one dsh + one data dir" as a unit. The desktop app **is** the isolation unit — the cloud runs one such unit ("cell") per user behind a thin gateway. Per-user MCP/skills isolation falls out of the cell boundary for free, superseding the shared-runtime overlay machinery (`user-runtime-bindings`) rather than extending it.

## What Changes

- **New cell boundary contract**: a cell = one `server.js` process + its dsh child + a per-user `PLATFORM_DATA_DIR` + per-user `DSH_HOME`, owning that user's SQLite DB, MCP config, skills, sessions, chat history, documents index, cron, and bots. No mutable state crosses cells; code and LLM gateway credentials are shared read-only via env.
- **New gateway process** (new entrypoint, same repo): terminates Logto authentication, maps session → user → cell, reverse-proxies HTTP and sticky-routes WebSocket upgrades to the user's cell, and owns cell lifecycle (spawn on first traffic, health, optional idle reap).
- **Cell lifecycle policy**: cells are **always-on by default** (spawn at first request, never reaped). Optional idle reaping exempts cells with enabled cron jobs or bots — the documented contract is "reaped cell = user offline: chat unavailable, scheduled jobs do not fire for that user".
- **Identity trust boundary**: in cloud mode the cell consumes `x-forwarded-user`/`x-forwarded-groups` **only from the gateway** (loopback/private-network restriction or shared secret); the gateway is the sole Logto client in the cloud deployment.
- **Phase 3 (explicitly out of scope, future change)**: k8s pod-per-user with per-user PVCs, autoscaling, object-store backups. The gateway↔cell contract designed here must survive that swap (spawner becomes an orchestrator, nothing else changes).
- **Desktop unchanged**: packaged app keeps running its local cell exactly as today (supervisor, userData dir, local auth mode). Desktop↔cloud data sync is out of scope.
- **Superseded**: the shared-runtime per-user overlay machinery (`server/runtime-bindings.js` — pendingBindings, busy-window apply, owner flipping) is retired; in a cell the single user **is** the runtime owner, and their model/MCP bindings are plain cell-local state applied at cell start.
- **Unchanged**: single-process `npm start` dev mode (gateway optional, auth off = open access, same as today).

## Capabilities

### New Capabilities

- `tenant-cell-runtime`: the per-user isolation unit — what runs inside a cell, the env/path parameters that define its boundary, and the requirement that all per-user mutable state stays inside it.
- `cell-gateway`: the cloud front door — Logto authentication for the hosted deployment, session→cell routing with WS affinity, cell lifecycle (spawn/health/optional reap with the cron-exemption rule), and the identity-header trust boundary between gateway and cells.

### Modified Capabilities

- `forward-auth`: header-trust requirement tightened — injected identity headers are honored only from the configured gateway source, not from any client that can reach the server.
- `user-runtime-bindings`: per-user model/MCP bindings become cell-scoped startup state; the shared-runtime busy/pending overlay semantics and runtime-owner flipping are removed.

## Impact

- **New code**: gateway entrypoint (auth + proxy + WS routing + spawner) in a new top-level module (or `gateway/`); a cell-spawner that launches `server.js` children with per-user env (`PLATFORM_DATA_DIR`, `DSH_HOME`, `MCP_CONFIG_PATH`, per-cell loopback port).
- **Server**: `server.js`/`server/*` mostly unchanged (env-parameterized already); audit task for CWD-relative writes in cloud mode; `runtime-bindings.js` retirement touches `server/ws.js` (`apply_bindings`/`list_bindings` handlers), `server/routes/user-bindings.js`, and the WS greeting/broadcast paths that reference overlays.
- **Supervisor/desktop**: no behavior change; the spawner reuses supervisor's process-descriptor patterns where they fit.
- **Deployment**: k8s gains a gateway Deployment in front (cells initially same-pod or same-node child processes); per-user data under a host volume `/data/<user>` (local disk only — SQLite/WAL must not sit on NFS).
- **Config**: new env — `CLOUD_MODE=1`, gateway bind/port, `CELL_DATA_ROOT`, idle-reap knobs (`CELL_IDLE_REAP_SECS`, default off), gateway↔cell trust secret. Reuses `LOGTO_*` and existing `PLATFORM_DATA_DIR`/`DSH_HOME`/`MCP_CONFIG_PATH`.
- **Docs**: `.env.example`, README cloud-deployment section; PRODUCT.md positioning update is a follow-up, not part of this change.
