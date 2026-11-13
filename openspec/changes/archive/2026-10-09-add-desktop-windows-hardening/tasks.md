# add-desktop-windows-hardening — tasks

## 1. Renderer reachability (black screen)

- [x] 1.1 Health probes target the backend's bound address (`supervisor/descriptors.js` derives the probe URL from the same host the child is given) — verified: probe and window now agree
- [x] 1.2 Desktop backend binds IPv4 loopback (`electron/main.js` seeds `HOST=127.0.0.1` for packaged runs) — verified locally: packaged app listens `127.0.0.1:47600`, `/api/config` 200
- [x] 1.3 Main process mirrors console output to `userData/main.log` plus an "Open Logs Folder" menu action — verified: log file contains the full boot sequence
- [x] 1.4 Window is created hidden, revealed on first successful load, retried with a bound on failure, force-revealed after a grace period — verified locally and on the runner

## 2. Packaging closure

- [x] 2.1 Peer-only runtime packages pinned as direct dependencies (18 runtime components plus the bridge chain) — verified: packaged tree contains them
- [x] 2.2 Runtime nested tree copied into the package by explicit resource declaration (172 packages) — verified: packaged nested tree matches the development tree
- [x] 2.3 Install uses relaxed peer resolution; the lockfile stays authoritative — verified: release build succeeds on all three matrix jobs
- [x] 2.4 `verify-bundle` fails the build when a bridge dependency or the nested tree is missing — verified: precheck passes on a complete tree

## 3. Profile resolution and readiness

- [x] 3.1 The app links the bridge packages into the profile's module directory, pointing at the app's own copies (Windows: junctions) — verified: isolated run logs the links and the child boots
- [x] 3.2 Only bridge packages are linked; runtime-owned paths are left to the runtime — verified: isolated run reaches `{"ready":true,"dshInitError":null}`
- [x] 3.3 Stale non-link entries on those paths are cleared before linking — verified: constructed a stale directory, reran, link is recreated and the runtime boot no longer aborts
- [x] 3.4 Readiness flips only when agent init succeeded; runtime events keep governing it afterwards — verified: degraded boot reports non-200 with the init error, healthy boot reports 200

## 4. Self-test and smoke gate

- [x] 4.1 In-app render self-test (`electron/smoke-selftest.js`): polled load wait, live DOM read, renderer frame capture, JSON report + PNG, exit 0/1 — verified bidirectionally
- [x] 4.2 Positive case: normal boot reports `ok:true` with mounted UI text and non-backdrop pixels — verified locally (`/login` rendered) and on the Windows runner (`/chat` rendered, full UI copy)
- [x] 4.3 Negative case: pointing the window at a dead port reports `ok:false` with a renderer-error URL and zero non-backdrop pixels — verified locally
- [x] 4.4 Smoke Phase C launches the installed app with the self-test enabled, asserts the exit status, and uploads report + screenshot — verified: run 37849702359 green with artifacts
- [x] 4.5 Smoke probes the window's exact URL on the desktop port before the backend probe — verified: "window target … -> 200" in the run log
- [x] 4.6 Direct backend probe sets the variables the backend actually reads (`PORT`/`HOST`) — verified: no more guaranteed-false-negative timeout
- [x] 4.7 Display-wide screenshot abandoned as evidence (wallpaper dominated the frame; the app window contributed zero pixels) — recorded in the phase's own comment

## 5. Release

- [x] 5.1 v1.3.8 released: tag → release build (three assets) → smoke green (A / A+ / B / C) → dl mirror (md5 matched) → site rolled to v1.3.8
- [x] 5.2 User re-tested the installed app: reported normal
