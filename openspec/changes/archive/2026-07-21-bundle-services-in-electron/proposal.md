## Why

The packaged `.dmg` today is not a self-contained install: LiteLLM and OpenConnector are declared as `http-external` in the supervisor and health-checked only. A user who downloads the app gets Volces chat working (via the fallback key baked into `server.js`) but has no LiteLLM extra models and no OpenConnector SaaS actions unless they run those services themselves. The stated goal is an "external download" distribution — the current packaging fails that goal.

## What Changes

- **BREAKING (packaging only, no runtime API change)**: `resources/` grows from ~50MB (bundled Node) to ~330MB per arch (adds OpenConnector `dist` + `node_modules`, `python-build-standalone`, LiteLLM venv). Compressed `.dmg` roughly doubles.
- Add a new `python` server descriptor kind to the supervisor and a spawned bundled variant of the existing `openconnector` descriptor (`kind: "node"` instead of `http-external`) — both keyed off whether their bundled resources are present, so external-runtime users are still supported (graceful degradation).
- First-run bootstrap: generate OpenConnector `runtime` + `admin` tokens (crypto-random) and persist them into `userData/settings.json` atomically. Seed `userData/litellm.yaml` from a bundled Volces-only template. Both idempotent — never overwrites an existing user file.
- OpenConnector SQLite database, runtime state, and LiteLLM YAML live under `PLATFORM_DATA_DIR` (i.e. `app.getPath("userData")` when packaged) so they survive app updates.
- Electron menu → **Preferences** window (phase 3) that edits Volces key, edits `litellm.yaml` (textarea), and regenerates OC tokens. All writes go through the main process — tokens never reach the renderer.
- Scope: **mac arm64 only** in this change. Windows/x64 packaging is deferred.

## Capabilities

### New Capabilities
- `first-run-bootstrap`: idempotent one-time initialization of `userData/` on first launch — seeds default `settings.json`, generates OpenConnector tokens, copies default `litellm.yaml`. Governs what gets seeded, when it runs, and how it degrades if seed files are missing (dev mode).
- `preferences-ui`: Electron main-process Preferences window that lets end users edit Volces credentials, edit `litellm.yaml`, and rotate OpenConnector tokens without leaking secrets into the renderer.

### Modified Capabilities
- `desktop-supervisor`: adds `python` as a supported `kind`; adds bundled variants of the `openconnector` and (new) `litellm` descriptors that the supervisor spawns instead of health-checking. Startup ordering, health probing, restart-with-backoff, and ordered shutdown all reuse the existing machinery. Retains the ability to run either service as `http-external` when its bundled resources are absent.

## Impact

- **electron/**: `main.js` boots a first-run bootstrap step before starting the supervisor; adds a Preferences window and IPC channel. `supervisor/descriptors.js` gains bundled `openconnector` + `litellm` entries and a `python` kind branch in `process.js`. `config/settings.js` grows helpers for atomic token generation and default-seeding.
- **resources/**: new `resources/openconnector/` (built dist + prod node_modules), `resources/python/` (standalone Python), `resources/litellm/venv/` (frozen pip install). Populated by build scripts under `scripts/`.
- **scripts/**: new `build-openconnector.js`, `build-python-litellm.sh` — reproducible fetch+build pinned to a git SHA (OC) and exact `==` version (LiteLLM). Wired into `npm run dist`.
- **electron-builder.yml**: `extraResources` list expanded; asar/npmRebuild flags unchanged.
- **open-connector.js / litellm registration in server.js**: unchanged — they still see standard env vars pointing at `localhost:<port>` and standard tokens; they don't know or care whether the process is bundled or external.
- **openspec/specs/desktop-supervisor**: delta amends the descriptor registry + startup ordering requirements to cover the new `python` kind and bundled OC/LiteLLM.
- **CI / build size**: `npm run dist` gains a mac-arm64-only prebuild step (~2 min) and the resulting `.dmg` grows to ~200-250MB.
- **No changes** to WebSocket protocol, REST APIs, chat/document/UI flows, or the "tokens never reach the browser" invariant.
