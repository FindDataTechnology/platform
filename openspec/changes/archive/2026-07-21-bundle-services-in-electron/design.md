## Context

The Electron supervisor (spec `desktop-supervisor`, code under `electron/supervisor/`) already orchestrates spawned + external servers with health-check-per-transport, restart-on-crash, ordered shutdown, and graceful degradation. The **descriptor registry** already declares `python` as a supported `kind` and lists all four servers (`server.js`, `pi-agent`, `litellm`, `openconnector`) — but `litellm` and `openconnector` are currently `http-external` with `start: null`. `resources/node/` already ships a bundled standalone Node (v25 arm64) that natively runs the backend + native addons (`asar: false`, `npmRebuild: false`).

The gap that motivates this change is packaging, not orchestration: to make the `.dmg` a self-contained "external download," we need the actual OpenConnector and LiteLLM binaries plus their config seeded on first run. The supervisor barely changes; the build pipeline, `resources/`, and a new `first-run-bootstrap` step do the real work.

Constraints (all pre-existing, none negotiable):
- Tokens never reach the browser — all secrets stay in the main process / child env
- Graceful degradation — a missing/unreachable optional service must not block launch
- Atomic persistence for anything in `userData/`
- `asar: false`, `npmRebuild: false`
- Bundled standalone Node runs all Node children so native-addon ABI matches
- `PLATFORM_DATA_DIR` (== `app.getPath("userData")` when packaged) is the only writable root

## Goals / Non-Goals

**Goals:**
- One-download experience on macOS arm64: launch `.dmg`, all four services come up, chat + LiteLLM extra models + OpenConnector actions work with no user config.
- Preserve the ability to *disable* bundled OC/LiteLLM and point at an external one instead (unset the bundled resources OR override `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` in settings).
- Reproducible builds: pin OC to a git SHA, LiteLLM to `==<version>`; `npm run dist` fully bootstraps `resources/` from a clean checkout.
- Preferences window (phase 3) that lets users edit Volces key, edit `litellm.yaml`, and rotate OC tokens without exposing tokens to the renderer.

**Non-Goals:**
- Windows / x64 packaging (deferred; the `electron-builder.yml` NSIS target stays as a placeholder but is not built in this change).
- OpenConnector cloud/Cloudflare deployment, OOMOL-hosted mode, or connector-catalog updates — we ship a snapshot.
- LiteLLM multi-provider config out of the box — bundled default is Volces-only. Users add more via the Preferences YAML editor.
- Auto-updating the bundled OC or LiteLLM at runtime — resources are frozen at build time; upgrading them means shipping a new app version.
- Any change to the WebSocket protocol or REST APIs.

## Decisions

### D1: Bundle OpenConnector as a `node` descriptor spawned by the same bundled Node

**Decision.** Build OpenConnector from a pinned git SHA in `scripts/build-openconnector.js`, output to `resources/openconnector/dist/` + `resources/openconnector/node_modules/`. Add a new descriptor `{ id: "openconnector", kind: "node", start: { cmd: nodeBin, args: [dist/index.js], env: {...} } }` gated on the resources being present.

**Rationale.** OpenConnector is TypeScript/Node ≥22. Our bundled Node is v25 — same ABI story as `server.js`. Zero extra runtime, no python needed for OC. Same `spawnServer` / health-probe / restart code path applies unchanged.

**Alternatives considered.**
- *Docker.* Rejected: requires Docker on the user's machine, defeats "external download."
- *Fork OC into the same server.js process.* Rejected: violates the runtime boundary (OC's whole point is credential isolation).

### D2: Bundle LiteLLM as a `python` descriptor with `python-build-standalone` + a frozen venv

**Decision.** Build step (`scripts/build-python-litellm.sh`) downloads a pinned `python-build-standalone` release for macOS arm64 into `resources/python/`, then runs `resources/python/bin/python3 -m venv resources/litellm/venv && venv/bin/pip install "litellm[proxy]==<pinned>"`. Extend `process.js` to handle the descriptor's `cmd = pythonVenvBin, args = ["-m", "litellm", "--port", "...", "--config", userData/litellm.yaml]`.

**Rationale.** LiteLLM only ships as a Python package. `python-build-standalone` is the standard way to embed a self-contained Python — no interpreter on the user's machine required. venv keeps site-packages hermetic and relocatable (LiteLLM does not depend on absolute install paths). Runtime kind `python` already exists in the spec — this change is what makes it real.

**Alternatives considered.**
- *Compile LiteLLM to a single binary with pyoxidizer/nuitka.* Rejected: LiteLLM has enormous transitive deps + dynamic import paths; brittle and slow to build.
- *Use system Python.* Rejected: not guaranteed on macOS 15+, version drift breaks reproducibility.
- *Reimplement the small slice of LiteLLM we use.* Rejected: LiteLLM's value is the full router/fallback/pricing surface — that IS why the user picked it.

### D3: First-run bootstrap runs in the Electron main process, before the supervisor starts

**Decision.** New module `electron/bootstrap/first-run.js` (called from `main.js` between `app.whenReady()` and `supervisor.start()`). It:
1. Ensures `userData/` exists.
2. Reads `userData/settings.json`; if missing, writes an atomic default (temp+rename) with the baked Volces fallback key.
3. If `OPENCONNECTOR_RUNTIME_TOKEN` / `OPENCONNECTOR_ADMIN_TOKEN` are unset in settings, generates two crypto-random 32-byte hex tokens and merges them in.
4. If `userData/litellm.yaml` is missing AND the LiteLLM resources bundle is present, copies `resources/litellm/default-config.yaml` to `userData/litellm.yaml` atomically.
5. Sets `OPENCONNECTOR_BASE_URL` / `LITELLM_BASE_URL` in the returned env to `http://127.0.0.1:0` sentinels that are re-resolved to the supervisor-assigned ports at spawn time (see D4).

**Rationale.** Bootstrap has to run before `resolveEnv()` so the supervisor sees the tokens. Idempotency guarantees a second launch never rewrites user edits. Keeping it in the main process means no browser code path can trigger a re-seed.

### D4: Bundled OC/LiteLLM ports come from `findFreePort`, not fixed 3000/4000

**Decision.** `Supervisor.start()` allocates one free port per spawned server (already does this for `server.js` via `serverPort`). Extend to `ocPort` and `litellmPort`. Descriptor env receives the resolved values; `server.js`'s env receives `OPENCONNECTOR_BASE_URL=http://127.0.0.1:<ocPort>` and `LITELLM_BASE_URL=http://127.0.0.1:<litellmPort>`. Sibling URLs are already threaded via `agentEnv`; extend that path.

**Rationale.** Fixed ports collide with anything else the user is running (LiteLLM's default is 4000 — clashes with fpm agent shops). Dynamic ports also let us keep `server.js` completely unaware of bundling — it just reads standard env vars.

### D5: Bundled vs external is a resource-presence probe, not a settings switch

**Decision.** At supervisor startup, check `fs.existsSync(resources/openconnector/dist/index.js)` and `resources/litellm/venv/bin/litellm`. If present AND the user hasn't set an explicit `OPENCONNECTOR_BASE_URL` / `LITELLM_BASE_URL` override in `settings.json`, use the bundled descriptor. If absent, or if the user set an override URL, use the existing `http-external` descriptor.

**Rationale.** Dev builds run `npm start:electron` without `npm run dist` and don't have `resources/openconnector/` populated — the app must still work by falling back to health-checking whatever the developer has running. This also gives us the "point at external OC" escape hatch essentially for free.

**Alternatives considered.**
- *Explicit `bundled: true` flag in settings.* Rejected: adds a user-visible knob for something that should Just Work; presence probe covers all the real cases.

### D6: LiteLLM default config ships Volces-only; the fallback API key is inlined

**Decision.** `resources/litellm/default-config.yaml` declares one model group (`volces-coding-plan-v3`) pointed at the Volces base URL, using `os.environ/VOLCES_API_KEY`. `master_key: sk-<random>` is generated at first-run bootstrap into `settings.json` (`LITELLM_API_KEY`), same pattern as OC tokens. `server.js` reads `LITELLM_API_KEY` from env as it does today — no code change.

**Rationale.** Volces is the one provider we know every downloader has access to (via the baked fallback). Anything richer belongs in the phase-3 Preferences editor.

### D7: Preferences window (phase 3) uses main-process IPC only

**Decision.** Add `electron/preferences/` with `window.js` (BrowserWindow loading a small HTML file), `ipc.js` (handles `settings:get`, `settings:set`, `settings:rotate-oc-tokens`, `litellm:get-config`, `litellm:set-config`). Renderer uses `contextBridge` to expose only the whitelisted channels. Actual reads/writes go through the same atomic helpers as bootstrap. Changing settings requires a supervisor restart of the affected server(s), which the IPC handler triggers.

**Rationale.** The existing invariant is "tokens never reach the browser." A preferences UI is one place that could break this if built as a regular authenticated web page. Keeping it in a separate BrowserWindow with contextIsolation + a narrow IPC surface is safer than adding an auth boundary to the main `/api`.

### D8: Bundle sizing + `extraResources` filtering

**Decision.** `resources/python/` and `resources/openconnector/node_modules/` include only files matching a whitelist filter in `electron-builder.yml` — drop `.pyc` caches, tests, docs, sample notebooks, unused stdlib modules from `python-build-standalone` (~30% shrink). Target: `.dmg` compressed ≤ 300 MB.

## Risks / Trade-offs

- **Bundle size doubles.** → Aggressive `extraResources` filter (D8). Ship arm64 only. Compression handles most of the rest.
- **`python-build-standalone` binary is unsigned.** → Notarize the whole app (existing `CSC_LINK` path); Gatekeeper accepts the embedded binary as part of the signed bundle. Confirmed by prior art (Positron, Cursor).
- **LiteLLM Python venv is platform-locked.** → Build on macOS arm64 CI; Windows/x64 will need a separate build. Deferred here.
- **OpenConnector schema evolves between our pinned SHA and upstream.** → Pin `mcp.json` to compatible tool names; if OC ships breaking changes we bump the SHA in one place and rebuild.
- **First-run bootstrap can be interrupted mid-write.** → All writes use temp+rename. Partial state on next boot = missing file, which the bootstrap re-seeds.
- **User edits `litellm.yaml` badly → LiteLLM crashes on boot → supervisor loop-restarts.** → Health probe fails, state stays `unhealthy`, respawn backoff caps at 15s (existing behavior). Preferences window can surface the last log lines so the user can fix their YAML.
- **A dev running `npm start:electron` after `npm run dist` inherits stale bundled resources.** → Add `.gitignore` for `resources/openconnector/`, `resources/python/`, `resources/litellm/` — they are build outputs, never committed.
- **Phase gaps are user-visible.** After phase 1, LiteLLM is still external. After phase 2, users still have no UI to change keys. → Ship phase 1 & 2 as internal / TestFlight-style previews if needed; phase 3 completes the story.

## Migration Plan

1. Land phase 1 (OpenConnector bundled). Existing installs with `OPENCONNECTOR_BASE_URL` set in `.env` / `settings.json` continue to use external OC (D5).
2. Land phase 2 (LiteLLM bundled). Existing installs with `LITELLM_BASE_URL` set continue to use external LiteLLM.
3. Land phase 3 (Preferences UI). No migration — new feature.

**Rollback:** revert the change; existing users still have `.env` / `settings.json` pointing at external services, so nothing breaks. The bundled resources are self-contained under `resources/` — removing them is enough to force `http-external` mode.

## Open Questions

- **Notarization key availability.** Do we have `CSC_LINK` set up in CI, or is this the first signed build? If first, add a task in phase 1 to procure a Developer ID.
- **LiteLLM version pin.** Latest stable at proposal time is `1.53.x`; do we want to pin to a specific patch, or track minor? Recommend exact `==1.53.<patch>` and bump quarterly.
- **OC ships DB migrations on first run.** Fine, but if we bump the SHA and the user has an existing `openconnector.db`, do OC migrations auto-run? Need to verify against their release notes before bumping.
