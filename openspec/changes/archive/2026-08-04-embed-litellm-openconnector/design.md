## Context

The project can already run LiteLLM (Python proxy) and OpenConnector (Node/tsx SaaS-actions gateway) **bundled and local** - the Electron desktop supervisor (`electron/supervisor/`) spawns both from `resources/{litellm,openconnector,python}/` on free localhost ports when bundled resources are present and no external URL override is set, then injects `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` into `server.js`'s env. The bundled resources already exist in this dev checkout (`resources/litellm/venv/`, `resources/openconnector/src/`, `resources/python/bin/python3`).

The gap: the **dev** entry point `npm start` (`node server.js`) never goes through the supervisor. It reads `.env`, which points at remote LAN servers (`192.168.1.4:4000`, `192.168.1.4:3000`). So a developer needs those remote boxes up to get LiteLLM/OpenConnector, even though everything required to run them locally is already on disk.

Key constraints (from CLAUDE.md + existing specs):
- **Graceful degradation**: every external dependency is optional; missing/unreachable deps log a warning and the server continues.
- **Tokens never reach the browser**; credentials live server-side.
- **Atomic persistence** for crash-sensitive registries (temp + rename).
- **server.js + its modules are URL-agnostic**: `open-connector.js`, `litellm-models.js`, `mcp-bridge.js` read `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` / tokens from env. Supplying localhost values changes nothing in them.
- The supervisor's `Supervisor` class + `getDescriptors` are **already parameterised** (`projectRoot`, `nodeBin`, `dataDir`, `agentEnv`) and already handle dev (`getResourceRoot` falls back to `path.join(projectRoot, "resources")`). The only Electron-specific code is `electron/main.js` (window) and `electron/first-run.js` / `electron/config/settings.js` (settings.json + `app.getPath("userData")`).

## Goals / Non-Goals

**Goals:**
- A developer running `npm start` gets working **local** LiteLLM + OpenConnector with no remote server dependency, when bundled resources are present.
- Reuse the supervisor's lifecycle machinery (descriptors, spawn, health, restart, shutdown) as a **single source of truth** shared by the packaged Electron app and the headless dev launcher - no duplicate spawn code.
- Preserve the existing remote/external workflow: setting `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` in `.env` still uses that remote server (opt-out of local).
- Preserve every existing contract: server.js, WS/REST protocols, `/oc-web` + `/litellm-web` proxies, "tokens never reach the browser", graceful degradation.

**Non-Goals:**
- Not changing how `server.js` discovers or talks to LiteLLM/OpenConnector (still env vars).
- Not bundling/building the resources here - the build scripts (`scripts/build-openconnector.js`, `scripts/build-python-litellm.sh`) already exist and are run via `predist`. This change assumes resources are built (and degrades cleanly when they aren't).
- Not touching the packaged Electron app's observable behavior.
- Not enabling the extracted `pi-agent` sidecar (stays `enabled: false`; pi runs in-process in server.js via the SDK, per CLAUDE.md).
- Not auto-managing LiteLLM models/keys (that's the existing `litellm-web` UI + `fd-paas-litellm-model-manage` skill).

## Decisions

### D1: Extract supervisor primitives to a shared, Electron-agnostic module; add a headless launcher that reuses them
**Choice:** Move `descriptors.js`, `process.js`, `health.js`, `logs.js`, `ports.js`, and the `Supervisor` class (from `lifecycle.js`) into a shared repo-root `supervisor/` package. `electron/supervisor/` becomes a thin adapter (resolves `nodeBin` from the bundle, wires `process.resourcesPath`, re-exports `Supervisor`). A new headless entry (`local-services.js` + `scripts/start.js`) constructs the same `Supervisor` with dev-resolved params and **no window**.

**Why:** The `Supervisor` + `getDescriptors` are already parameterised and dev-aware - the extraction is mostly moving files and fixing imports, with near-zero behavior risk. One lifecycle implementation serves both consumers, so restart-backoff/health-path/shutdown-order details can't drift.

**Alternatives considered:**
- *Duplicate spawn logic in a new launcher* - rejected: two implementations of tsx-path/sqlite-URL/token-env/health-paths/restart-backoff would inevitably drift; the supervisor encodes hard-won fixes (see the build-script comments).
- *Let `server.js` spawn its own deps in-process* - rejected: `server.js` is the orchestrator that *consumes* services; mixing process-supervision into it blurs responsibilities, complicates clean sidecar shutdown, and fights the "one agent session served to all clients" simplicity. Supervision belongs to a parent process.

### D2: The launcher is the parent process; `server.js` is its child
**Choice:** `npm start` runs the launcher. The launcher spawns LiteLLM + OpenConnector (when local) and `server.js` as siblings under the shared `Supervisor`, injects localhost URLs + creds into `server.js`'s env, stays alive to supervise, and on SIGINT/SIGTERM runs ordered shutdown.

**Why:** Mirrors the supervisor topology exactly; `server.js` is unchanged; sidecar shutdown is clean (parent owns the children). The launcher is headless - it opens no window.

### D3: Local-first, per-service external-URL override (opt-out, not a hard switch)
**Choice:** For each service independently: if bundled resources are present **and** the service's `*_BASE_URL` is unset in env, spawn locally; if the URL is set (external), pass it through and do not spawn. This reuses `getDescriptors`' existing bundled-vs-external resolution verbatim.

**Why:** Preserves the remote workflow and the graceful-degradation convention. A developer clears `LITELLM_BASE_URL`/`OPENCONNECTOR_BASE_URL` from `.env` to go local, or keeps them to stay remote. Per-service independence lets a user run local LiteLLM but remote OpenConnector (or vice-versa).

### D4: Dev first-run seeding reuses the bootstrap logic, extracted to an Electron-agnostic helper
**Choice:** Extract `electron/first-run.js`'s seeding (copy `resources/litellm/default-config.yaml` -> `<dataDir>/litellm.yaml`; generate `LITELLM_API_KEY` + OC runtime/admin tokens when absent) into a shared seeder that takes a `dataDir` + a settings-store path instead of `app.getPath("userData")`. The launcher runs it once before `Supervisor.start()`. Persist dev credentials to `<PLATFORM_DATA_DIR>/dev-settings.json` (atomic, idempotent), **not** by mutating the user's `.env`.

**Why:** Identical seeding semantics (idempotent, atomic, 32-byte hex tokens) for packaged and dev, via one implementation. A separate dev-settings file avoids rewriting `.env` (which the user owns) and keeps generated secrets out of the hand-edited file.

**Alternatives considered:**
- *Write generated creds back into `.env`* - rejected: `.env` is user-owned/hand-edited; silently rewriting it is surprising and risks clobbering comments/remote keys.
- *Require the user to pre-populate tokens in `.env`* - rejected: defeats "out of the box, local" goal.

### D5: `npm start` -> launcher; launcher degenerates to plain `server.js` when there's nothing to spawn
**Choice:** `package.json` `start` becomes `node scripts/start.js` (the launcher). When bundled resources are absent **and** no external URLs are set, the launcher still spawns `server.js` under the `Supervisor` (equivalent to today's `node server.js`). When resources are absent but an external URL **is** set, the supervisor health-checks the external service (as today).

**Why:** Single entry point; CI and external-only setups keep working; the only BREAKING nuance is that `npm start` no longer runs `node server.js` *directly* (it runs as a supervised child).

### D6: `nodeBin` resolution in dev = `process.execPath`; data dir = `PLATFORM_DATA_DIR` or CWD
**Choice:** The dev launcher passes `nodeBin = process.execPath` (the dev Node) and `dataDir = process.env.PLATFORM_DATA_DIR || <projectRoot>`. LiteLLM's `--config` and OC's sqlite DB land under `dataDir` (matching `paths.js`). The dev-settings file + `litellm.yaml` live there too.

**Why:** `paths.js` already defines `PLATFORM_DATA_DIR` semantics (CWD-relative when unset). Reusing it keeps all dev state in one predictable place. `process.execPath` is correct for spawning `server.js` + OC (tsx) in dev.

## Risks / Trade-offs

- **[Fresh clone has no built resources]** -> The launcher detects absence via `hasBundledLiteLLM`/`hasBundledOpenConnector` and degrades to `server.js`-only with a clear warning + a hint to run `node scripts/build-openconnector.js && sh scripts/build-python-litellm.sh`. Documented in README/CLAUDE.md. (Already-built in this checkout.)
- **[Behavior change: `npm start` is now supervised]** -> Surface as BREAKING in the proposal; the launcher's degenerate path is observably equivalent to `node server.js`. e2e tests that invoke `node server.js` directly are unaffected. Rollback = revert one `package.json` line.
- **[Dev-settings file leaks secrets if committed]** -> Add `<PLATFORM_DATA_DIR>`/`dev-settings.json` (and the data dir default) to `.gitignore`; the file is under the gitignored data dir. Tokens never sent to the browser (unchanged).
- **[LiteLLM (Python) / OC slow first start]** -> `server.js` treats both as optional and starts in parallel (per `desktop-supervisor` "Ordered startup" requirement); UI shows them coming up green/red without blocking the chat.
- **[Port collisions on free-port assignment]** -> Reuses the supervisor's `findFreePort("127.0.0.1")`; no change.
- **[Shared-module extraction regresses the packaged app]** -> The extraction preserves all existing `desktop-supervisor` scenarios; verify via the existing e2e smoke test after extraction. Low risk because `getDescriptors`/`Supervisor` are already parameterised.

## Migration Plan

1. **(One-time, already done in this checkout)** Build the bundled resources: `node scripts/build-openconnector.js && sh scripts/build-python-litellm.sh`.
2. Extract shared supervisor primitives + seeder (D1, D4); rewire `electron/supervisor/` + `electron/first-run.js` to delegate. Run e2e smoke to confirm no packaged-app regression.
3. Add the headless launcher (`scripts/start.js` + `local-services.js`); wire `npm start` to it (D5).
4. To go local: clear `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` (and the remote tokens) from `.env`. To stay remote: leave them. The launcher honors either.
5. `npm start` now brings up local LiteLLM + OpenConnector + server.js.

**Rollback:** Either set external URLs in `.env` (launcher uses them, no spawn) or revert `package.json` `start` to `node server.js`.

## Open Questions

- **Dev-settings location confirmation:** Default to `<PLATFORM_DATA_DIR>/dev-settings.json` (CWD-relative when `PLATFORM_DATA_DIR` unset), gitignored. Acceptable, or prefer a fixed `.platform/` dir at repo root? (Default chosen; revisit if the user prefers a fixed path.)
- **Launcher readiness UX:** Should `npm start` print a one-line summary of which services are local-vs-external-vs-absent after startup? (Proposed: yes, minimal log line per service - matches the supervisor's existing `[litellm]`/`[open-connector]` log style.)
