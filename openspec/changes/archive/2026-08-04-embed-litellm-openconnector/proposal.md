## Why

Today the dev entry point (`npm start` → `node server.js`) talks to **remote** LiteLLM and OpenConnector servers whose URLs live in `.env` (`LITELLM_BASE_URL=http://192.168.1.4:4000`, `OPENCONNECTOR_BASE_URL=http://192.168.1.4:3000`). Yet the project already ships **bundled** copies of both services (`resources/litellm/`, `resources/openconnector/`, `resources/python/`) and already has the logic to spawn them locally - it just lives inside the Electron desktop supervisor (`electron/supervisor/`), which `npm start` never invokes. We want a developer running the project to get working LiteLLM + OpenConnector **out of the box, locally, with no remote server dependency** - reusing the supervisor's existing spawn machinery rather than duplicating it.

## What Changes

- **Extract the supervisor's spawn primitives into a shared, Electron-agnostic module.** The descriptor registry (`descriptors.js`), process spawn/stop (`process.js`), HTTP health probing (`health.js`), and lifecycle orchestration (`lifecycle.js` - ordered startup, health-gated readiness, restart-on-crash with backoff, ordered shutdown, status/logs) move to a shared location consumed by **both** the Electron supervisor and a new headless launcher. No observable change to the packaged app's behavior.
- **Add a headless local-services launcher** invoked by `npm start`. When bundled LiteLLM/OpenConnector resources are present on disk **and** no external URL override is set, the launcher spawns them as child processes on free localhost ports (Volces env, LiteLLM `--config`, OC sqlite DB + tokens), injects `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` = `http://127.0.0.1:<port>` into `server.js`'s env, then spawns `server.js` - exactly as the desktop supervisor does. `server.js` and its modules are unchanged: they discover the services through the same env vars.
- **Dev first-run seeding.** The launcher performs the equivalent of `first-run-bootstrap` for headless runs: seed `litellm.yaml` from `resources/litellm/default-config.yaml` (idempotent, atomic) into the data dir, and generate the service credentials the bundled processes need (`LITELLM_API_KEY`/master key, `OPENCONNECTOR_RUNTIME_TOKEN`/`ADMIN_TOKEN`) when absent, persisting them to a dev settings file under `PLATFORM_DATA_DIR`. Tokens never reach the browser (unchanged).
- **External override still honored (graceful).** If `.env` sets `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` to an external URL, the launcher skips spawning that service and uses the URL as-is - preserving the existing remote-mode workflow. So going local is opt-out via env, not a hard switch.
- **`npm start` becomes the launcher.** When bundled resources are absent or external URLs are set, the launcher degenerates to spawning `server.js` alone (today's behavior), so CI and external-only setups are unaffected. **BREAKING** only in the narrow sense that `npm start` no longer runs `node server.js` directly - it runs the launcher, which execs `server.js` as a child.

## Capabilities

### New Capabilities
- `local-services-launcher`: A headless (non-Electron) process supervisor that brings up the bundled LiteLLM + OpenConnector services locally - and `server.js` - for `npm start` / dev runs. Covers shared-primitive reuse, local spawn with external-URL override, dev first-run seeding of `litellm.yaml` and service tokens, localhost-URL injection into `server.js`, health/restart/shutdown lifecycle, graceful degradation, and the `npm start` entry point.

### Modified Capabilities
- `desktop-supervisor`: The server-descriptor registry, spawn, health, restart, and shutdown primitives SHALL be extracted into a shared Electron-agnostic module consumed by both the desktop supervisor and the `local-services-launcher`, with no change to the supervisor's observable behavior. The descriptor resolution that already chooses bundled-vs-external is reused verbatim by the launcher.

## Impact

- **New code**: shared supervisor primitives module (extracted from `electron/supervisor/{descriptors,process,health,lifecycle}.js`); a headless launcher entry (e.g. `local-services.js` + `scripts/start.js`) invoked by `npm start`; an Electron-agnostic first-run seeding helper (extracted from `electron/first-run.js`).
- **Modified code**: `package.json` (`start` → launcher); `electron/supervisor/*` and `electron/first-run.js` delegate to the shared modules (behavior preserved); `electron/main.js` unchanged call sites.
- **Unchanged contracts**: `server.js`, `open-connector.js`, `litellm-models.js`, `mcp-bridge.js` keep reading `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` / tokens from env - the launcher just supplies localhost values. WS/REST protocols, the `/oc-web` + `/litellm-web` proxies, and "tokens never reach the browser" are untouched.
- **Config**: `.env` remote URLs/tokens become optional - clear them to go local, keep them to stay remote. Dev credentials persist under `PLATFORM_DATA_DIR` (CWD-relative when unset, matching `paths.js`).
- **Dependencies/systems**: No new npm deps. Relies on the already-built `resources/{litellm,openconnector,python,node}/` (produced by `scripts/build-openconnector.js` + `scripts/build-python-litellm.sh`). LiteLLM (Python venv) and OpenConnector (Node/tsx) run as localhost child processes on macOS arm64.
