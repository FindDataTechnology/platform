## 1. Phase 1 — Bundle OpenConnector

### 1a. Build pipeline
- [x] 1.1 Add `scripts/build-openconnector.js`: clone `github.com/oomol-lab/open-connector` at a pinned SHA into a temp dir, `npm ci`, `npm run build`, copy `dist/` + prod-only `node_modules/` (`npm install --omit=dev`) into `resources/openconnector/`.
- [x] 1.2 Record the OC pin in `package.json` (`platformBundles.openconnectorSha` field) so the build script + docs share one source of truth.
- [x] 1.3 Add `resources/openconnector/`, `resources/python/`, `resources/litellm/`, `resources/node/*.tar.gz` to `.gitignore` (some already present — confirm).
- [x] 1.4 Wire `scripts/build-openconnector.js` into `npm run dist` via a `predist` script: `"predist": "node scripts/build-openconnector.js"`.
- [x] 1.5 Update `electron-builder.yml` `extraResources` to include `resources/openconnector/` (with a filter that drops `test/`, `docs/`, `.md`, `.map`, source `.ts`).

### 1b. Supervisor changes
- [x] 1.6 In `electron/supervisor/descriptors.js`, add a helper `hasBundledOpenConnector(projectRoot)` that returns `true` iff `resources/openconnector/dist/index.js` exists (checked relative to `process.resourcesPath` when packaged, `projectRoot` in dev).
- [x] 1.7 Rewrite the `openconnector` descriptor: if bundled AND user has NOT set `OPENCONNECTOR_BASE_URL` to a non-`localhost` URL in settings, return a `kind: "node"` descriptor with `start: { cmd: nodeBin, args: [<oc dist entry>], cwd: <oc dir>, env: { PORT: <freeOcPort>, DATABASE_URL: "file:" + dataDir + "/openconnector.db", RUNTIME_TOKEN, ADMIN_TOKEN, NODE_ENV: "production" } }`, `url: http://127.0.0.1:<freeOcPort>`, `healthPath: "/v1/health"`. Otherwise keep the existing `http-external` branch.
- [x] 1.8 In `electron/supervisor/lifecycle.js` `start()`, allocate `this.ocPort = await findFreePort("127.0.0.1")` and pass it into `getDescriptors(...)`.
- [x] 1.9 In `getDescriptors(...)`, thread `ocPort` into the OC descriptor's env AND into `server-js`'s `env.OPENCONNECTOR_BASE_URL = http://127.0.0.1:${ocPort}` when the bundled OC is enabled.
- [x] 1.10 Verify `spawnServer` in `electron/supervisor/process.js` handles the new descriptor unchanged (it should — cmd/args/env is generic).

### 1c. First-run bootstrap (OC portion)
- [x] 1.11 Create `electron/bootstrap/first-run.js` exporting `runFirstRun({ userDataDir, resourcesDir })`. Idempotent, atomic (temp+rename via `fs.writeFileSync` then `fs.renameSync`).
- [x] 1.12 Bootstrap step: if `settings.json` missing, write `{}` atomically. Parse it defensively — if unparseable, log and abort with a clear error the supervisor can surface.
- [x] 1.13 Bootstrap step: if bundled OC resources present AND `OPENCONNECTOR_RUNTIME_TOKEN` absent from settings, generate `crypto.randomBytes(32).toString("hex")`, merge into settings, write atomically. Repeat for `OPENCONNECTOR_ADMIN_TOKEN`.
- [x] 1.14 In `electron/main.js`, call `runFirstRun(...)` after `app.whenReady()` and before `new Supervisor(...)`. Wrap in try/catch that opens the error window on failure.

### 1d. Verification
- [x] 1.15 Add a dev-mode override: `PLATFORM_OC_BUNDLED_ROOT=<path>` env var lets a developer point at a locally-built OC without running the full `dist`. Documented in `CLAUDE.md`.
- [ ] 1.16 Manual test: `rm -rf ~/Library/Application\ Support/Platform && npm run dist && open dist/Platform-*-arm64.dmg` → drag to /Applications → launch. Confirm OC panel enabled, `list_apps` MCP tool works, no external OC running.
- [ ] 1.17 Manual test: settings.json with explicit `OPENCONNECTOR_BASE_URL=http://192.168.1.4:3000` overrides the bundle and the child is NOT spawned. Verified via `Supervisor.status()` showing `kind: "http-external"`.

## 2. Phase 2 — Bundle LiteLLM

### 2a. Build pipeline (Python + venv)
- [x] 2.1 Add `scripts/build-python-litellm.sh`: download `python-build-standalone` (pinned release for macOS arm64) into `resources/python/`, strip tests + `__pycache__` + unused stdlib (`ensurepip`, `idlelib`, `turtledemo`, `tkinter/test`, `test/`) to shrink.
- [x] 2.2 Same script: `resources/python/bin/python3 -m venv resources/litellm/venv` then `resources/litellm/venv/bin/pip install --no-cache-dir "litellm[proxy]==<pinned>"`. Strip pip's `__pycache__` after.
- [x] 2.3 Record the LiteLLM pin in `package.json` (`platformBundles.litellmVersion`) and the python-build-standalone pin (`platformBundles.pythonBuildStandaloneRelease`).
- [x] 2.4 Add `resources/litellm/default-config.yaml` with one Volces model group (`volces/deepseek-v4-pro`, points at `os.environ/VOLCES_API_KEY`, base_url from `os.environ/VOLCES_BASE_URL`, `master_key: os.environ/LITELLM_API_KEY`).
- [x] 2.5 Wire `scripts/build-python-litellm.sh` into `predist` alongside the OC step.
- [x] 2.6 Update `electron-builder.yml` `extraResources` for `resources/python/` and `resources/litellm/venv/` and `resources/litellm/default-config.yaml`. Add filters to drop `.pyc`, `*.dist-info/tests/`, `test/`, `tests/`, `*.pyi.h` from the venv.

### 2b. Supervisor changes (python kind)
- [x] 2.7 Extend `descriptors.js` with `hasBundledLiteLLM(projectRoot)` — checks `resources/litellm/venv/bin/litellm` AND `resources/python/bin/python3` both exist.
- [x] 2.8 Rewrite the `litellm` descriptor: if bundled AND user has NOT set an external `LITELLM_BASE_URL`, return `kind: "python"` with `start: { cmd: <venv litellm bin>, args: ["--port", String(litellmPort), "--config", path.join(dataDir, "litellm.yaml")], cwd: <venv root>, env: { VOLCES_API_KEY, VOLCES_BASE_URL, LITELLM_API_KEY } }`, `url: http://127.0.0.1:<litellmPort>`, `healthPath: "/health/liveliness"`.
- [x] 2.9 In `lifecycle.js`, allocate `this.litellmPort` alongside `ocPort`; thread into descriptors + `server-js` env.
- [x] 2.10 Verify `process.js` `spawnServer` handles `kind: "python"` — it's just another cmd/args, but add a defensive `fs.existsSync(cmd)` check that marks the server `unhealthy` with a clear error if the interpreter is missing (per spec).

### 2c. Bootstrap (LiteLLM portion)
- [x] 2.11 In `runFirstRun`, if bundled LiteLLM resources present AND `userData/litellm.yaml` missing, copy `resources/litellm/default-config.yaml` → `userData/litellm.yaml` atomically.
- [x] 2.12 In `runFirstRun`, if bundled LiteLLM present AND `LITELLM_API_KEY` absent, generate `sk-<hex32>` and store in settings.
- [x] 2.13 Confirm `server.js` picks up `LITELLM_BASE_URL` + `LITELLM_API_KEY` unchanged (no code edits expected).

### 2d. Verification
- [x] 2.14 Add dev-mode override `PLATFORM_LITELLM_BUNDLED_ROOT=<path>`.
- [ ] 2.15 Manual test: fresh install `.dmg`, confirm LiteLLM child appears in `Supervisor.status()` with a random localhost port, model selector shows the Volces model routed through LiteLLM.
- [ ] 2.16 Manual test: intentionally break `userData/litellm.yaml` (bad YAML), confirm the child fails to start, `Supervisor.status()` shows `unhealthy` with stderr in `logs`, and the rest of the app still works.

## 3. Phase 3 — Preferences window

### 3a. Window + IPC scaffold
- [x] 3.1 Create `electron/preferences/window.js`, `electron/preferences/preload.js`, `electron/preferences/renderer/index.html` + `renderer.js`. Renderer uses vanilla HTML (no bundler).
- [x] 3.2 Add the app menu with `Preferences…` (`⌘,`) in `electron/main.js`. On click, open a singleton BrowserWindow with `contextIsolation: true`, `nodeIntegration: false`, `preload: preload.js`.
- [x] 3.3 In `preload.js`, `contextBridge.exposeInMainWorld("platform", { getVisibleSettings, setSettingField, getLiteLLMConfig, setLiteLLMConfig, rotateOcTokens, restartService })`. Each function proxies to `ipcRenderer.invoke("<channel>", ...)`.

### 3b. IPC handlers
- [x] 3.4 `electron/preferences/ipc.js`: register `settings:get-visible` returning a whitelisted subset of `settings.json` — `VOLCES_API_KEY` (masked as `sk-***xxxx` in transit? or last-4? spec allows editing; return actual value for prefilling), `VOLCES_BASE_URL`, `LITELLM_API_KEY`. NEVER return OC tokens.
- [x] 3.5 Register `settings:set-field` with a key allowlist (`VOLCES_API_KEY`, `VOLCES_BASE_URL`, `DEFAULT_MODEL`, `DOCUMENTS_MODEL`). Reject others.
- [x] 3.6 Register `litellm:get-config` → reads `userData/litellm.yaml`, returns text.
- [x] 3.7 Register `litellm:set-config` → writes atomically to `userData/litellm.yaml`.
- [x] 3.8 Register `openconnector:rotate-tokens` → generates new tokens, writes to settings atomically, returns `{ ok: true }` only (never the tokens).
- [x] 3.9 Register `service:restart` with a service id allowlist (`server-js`, `litellm`, `openconnector`). Calls a new `Supervisor.restart(id)` method.

### 3c. Supervisor restart hook
- [x] 3.10 Add `Supervisor.restart(id)`: stop the child (`stopChild` with 5s timeout), set state `stopped`, then re-invoke `_startServer(id)`. For `http-external` no-op the stop and just re-probe.
- [x] 3.11 Cascade rule for token rotation: rotating OC tokens must restart both `openconnector` and `server-js` (since the latter has the old tokens in its env). IPC handler orchestrates this.

### 3d. Renderer UI
- [x] 3.12 Preferences renderer HTML: three tabs (General, LiteLLM, OpenConnector).
  - General: text input for `VOLCES_API_KEY`, `VOLCES_BASE_URL`. Save button.
  - LiteLLm: `<textarea>` with YAML content, read-only `LITELLM_API_KEY` display + copy button, Save button, "Last error" pane populated after a failed restart.
  - OpenConnector: single "Regenerate tokens" button with a confirm dialog.
- [x] 3.13 On save, call the corresponding IPC, then call `service:restart` for the affected service(s). Show a small "Restarted" toast.

### 3e. Verification
- [ ] 3.14 Manual test: change Volces key in Preferences, confirm `server.js` restarts, chat works with new key.
- [ ] 3.15 Manual test: paste an invalid YAML in the LiteLLM tab, save, confirm LiteLLM enters `unhealthy` state and the last-error pane shows stderr.
- [ ] 3.16 Manual test: rotate OC tokens, confirm both services restart, chat + OC actions continue to work, and the response to `openconnector:rotate-tokens` does not contain the token values (inspect main-process log to verify).

## 4. Build & release polish

- [x] 4.1 Add a `platformBundles` block to `package.json` documenting pinned OC SHA, LiteLLM version, python-build-standalone release.
- [x] 4.2 Add a `scripts/verify-bundle.js` post-build check: verifies `resources/openconnector/dist/index.js`, `resources/python/bin/python3`, `resources/litellm/venv/bin/litellm` all exist; fails `npm run dist` if any missing.
- [x] 4.3 Update `README.md` (or `CLAUDE.md` Architecture section) with a "Packaged app bundle contents" table matching design.md D8.
- [ ] 4.4 Confirm the compressed `.dmg` size ≤ 300 MB; if larger, tighten `extraResources` filters.
- [x] 4.5 If `CSC_LINK` / `CSC_KEY_PASSWORD` unset, print a clear WARN in `predist`; Gatekeeper will block the DMG on other machines otherwise.
- [ ] 4.6 Update `openspec/specs/desktop-supervisor/spec.md` (via `openspec sync`) after archiving.
