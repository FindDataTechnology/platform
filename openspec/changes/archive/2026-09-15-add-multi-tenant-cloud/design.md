## Context

Single-tenant today: `server.js` composes one app context (`server/context.js` — singleton `ctx`, `broadcast()` fans to every connected socket), spawns one dsh runtime, and writes all state under `PLATFORM_DATA_DIR` (dev: CWD-relative; desktop: userData via supervisor). Logto login ships (`server/logto-auth.js`); forward-auth trusts `x-forwarded-*` headers on reachability assumptions. Per-user model/MCP bindings exist as a shared-runtime overlay (`server/runtime-bindings.js`) — busy-window pending applications and runtime-owner flipping — built for "many users, one runtime", the opposite of the target.

The six stores (chat-history, documents, sessions, cron, extension, workdir) are better-sqlite3 + WAL; SQLite on NFS corrupts, so per-user data must stay on local disk. The desktop packaging (Electron + bundled Node + supervisor) already runs exactly one server + one dsh + one data dir — the cell's shape, already shipping.

## Goals / Non-Goals

**Goals:**

- Hosted multi-user deployment where users are mutually isolated at the process level, delivered by orchestration, not by rewriting the app multi-tenant.
- The gateway↔cell contract is narrow enough that Phase 3 (k8s pod-per-user, PVCs) swaps the spawner for an orchestrator without touching cells.
- Zero behavior change for dev mode and the desktop app.

**Non-Goals:**

- Shared-process multi-tenancy (per-user ctx pool, multi-tenant Postgres) — highest rewrite cost, weakest isolation; rejected, not deferred.
- Desktop↔cloud data sync (documents/chat history follow the user across homes).
- Per-user LLM credentials/billing — cells share the org gateway env.
- Gateway-side group→MCP-set mapping (the Logto-groups idea explored before this change) — per-cell config makes it unnecessary; revisit only if per-user MCP curation at scale becomes a burden.
- Horizontal gateway HA, multi-region.

## Decisions

### D1. Isolation unit = process-per-user cell; codebase stays single-tenant

A cell is `server.js` run with per-user env: `PLATFORM_DATA_DIR=$CELL_DATA_ROOT/<user>`, `DSH_HOME` (same root), `MCP_CONFIG_PATH` (same root), a loopback port, and hosted-mode auth trust. The single-tenant assumptions (singleton ctx, broadcast-to-all-sockets, one dsh) become correct because a cell's sockets all belong to one user. Nothing inside a cell learns other users exist.

*Alternative rejected:* shared process with per-user dsh children — requires threading a user-scoped ctx through every `server/*` module, every store, and the WS handler; months of churn for logical-only isolation. *Alternative deferred:* container-per-user (Phase 3 hosts the same cells on k8s).

### D2. Gateway is a separate thin process, not a mode inside server.js

New entrypoint (`gateway.js` or `gateway/`): Logto session verification (reuse `server/logto-auth.js`'s cookie machinery directly), an HTTP reverse proxy, WS sticky routing, and the cell spawner/lifecycle. It never touches per-user data. Cells bind loopback-only ports; the gateway is the only reachable surface.

*Why separate:* keeps `server.js` free of routing/lifecycle concerns (desktop/dev unaffected), and lets Phase 3 replace the spawner in one file. *Alternative rejected:* teaching server.js to both serve and route — couples the two lifecycles and re-opens the singleton-ctx question.

### D3. Gateway→cell identity: forwarded headers over loopback, with a shared-secret handshake

The gateway authenticates (Logto), then proxies to the cell injecting `X-Forwarded-Email`/`X-Forwarded-Groups` (the existing forward-auth contract — cells need no new auth code). Hosted mode adds an active check: a `CELL_GATEWAY_SECRET` header/value pair the cell validates before honoring identity headers, since loopback binding alone is defense-in-depth, not a boundary on shared hosts. Cells reject identity headers lacking the secret.

*Alternative rejected:* per-cell Logto validation — N× token verification, N× JWKS caches, and the cell would still need to trust the gateway's routing.

### D4. Cell lifecycle: spawn on demand, always-on default, cron/bot exemption from reaping

First authenticated traffic for a user starts their cell (~seconds: server boot + dsh init; acceptable at B2B scale). Default: cells stay resident. `CELL_IDLE_REAP_SECS` (default: off) enables reaping with a hard exemption: a cell with any enabled cron job or enabled bot is never reaped — rule is cheap to evaluate (two SQLite queries at reap-check time) and keeps the "scheduled jobs fire" promise honest. The offline contract is documented, not hidden.

*Alternative rejected:* lifting cron into a separate always-on per-user scheduler — a new service with its own failure modes; revisit only if resident cells' memory cost becomes real at scale.

### D5. Data layout and the SQLite constraint

`$CELL_DATA_ROOT/<userId>/` holds everything the cell writes (DB, sessions, cron, documents index, dsh home, mcp.json). `userId` is the stable Logto identity (email hash or sub). The root must be a local volume (hostPath/local PV in k8s later); NFS is prohibited for the WAL files. Backup/restore and migration are Phase 3 concerns; the layout is chosen now so they're per-directory operations.

### D6. Retire the shared-runtime overlay (`runtime-bindings.js`)

In a cell, the user is the runtime's only owner: bindings apply like the global paths already do (model save restarts the bridge exactly as `set_model` does; MCP saves rewrite the patch and hot-swap). `apply_bindings`/pendingBindings/owner-flip machinery is deleted; `list_bindings`/binding persistence stay (the REST surface survives, simplified). The `user-runtime-bindings` spec deltas capture the semantics change.

### D7. Broadcast scoping falls out of routing, needs no code change — verify, don't build

`ctx.broadcast()` reaches every socket a cell owns; in hosted mode the gateway guarantees those sockets are one user's. The verification task proves it (two browsers, two users, concurrent streams); no refactor.

## Risks / Trade-offs

- **Memory per resident cell** (Node + dsh + page cache, roughly 150–300 MB): fine to low hundreds of users on a small pool; the always-on default trades RAM for simplicity. Reaping + Phase 3 density work are the pressure valves.
- **Cold-start latency on first visit / after reap**: seconds, once per idle cycle. Mitigation: pre-warm on login page load (spawner may start a cell when the session check succeeds, before any app request).
- **Blast radius of a cell bug stays inside the cell, but a gateway bug hits everyone**: the gateway is deliberately tiny (auth + proxy + spawn) to keep its review surface small; it holds no per-user data.
- **`x-forwarded-*` trust hardening touches existing auth paths** (forward-auth and optional-SSO modes): the secret check must be strictly hosted-mode-gated to avoid breaking dev/desktop/proxy deployments that relied on reachability-only trust.
- **Cron semantics are only as honest as the exemption rule**: a disabled-but-expected job still won't block reaping; the docs task states the rule in terms of *enabled* jobs/bots.
- **Phase 3 defers PVC/backup work**: a host loss loses that host's users' data until backups exist; acceptable for a first hosted cut, must be explicit in deployment docs.
