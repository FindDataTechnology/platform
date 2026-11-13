# Tasks — fix-ops-console-board-alarms

## 1. platform probe re-point (D1' — gateway stays off /api/ready)

> Apply-time correction: the grilled "gateway adds anonymous /api/ready" plan (original 1.1–1.4) was falsified — `/api/ready` through the gateway is proxied to the caller's cell and carries dsh-agent boot depth (503 while booting); a shallow gateway route shadows that contract (deterministic `test-cell-gateway` failure in isolated worktree, `waitForCellReady` → premature 200 → sessions POST 500 `ctx.session null`). The interim alias commit was reverted; no image rollout is needed.

- [x] 1.1 Patch `ops-console-secrets`: `PROBE_PLATFORM_URL` → `http://100.64.0.12:31870/healthz`; rollout restart console
- [x] 1.2 Revert the interim gateway `/api/ready` alias (commit on main); confirm `git diff` clean vs pre-change gateway
- [x] 1.3 Verify live: platform probe ok on the board (was `HTTP 401`); `curl 100.64.0.12:31870/healthz` → 200; gateway `/api/ready` anonymous behavior unchanged (401 via catch-all — the per-user deep contract intact)
- [x] 1.4 Regression evidence archived in design.md: isolated-worktree A/B (HEAD green / HEAD+alias red), main-tree flake attributed to the parallel session's `server/*` churn

## 2. Console: drift de-Jenkinsed + truthful ages + legend

- [x] 2.1 `services/ops-console/index.js`: add main-guard (poll boot + `server.listen` behind `import.meta.url === pathToFileURL(process.argv[1]).href`); export pure helpers (`computeDrift`, new `storeLastOk`) for tests — file stays single-file, zero deps
- [x] 2.2 `computeDrift(runningTag, argocd)` (Jenkins input removed): delete `newer-build-not-rolled` / `cluster-out-of-sync-and-stale`; states = `in-agreement` (Synced), `cluster-out-of-sync` (OutOfSync), `unknown` (no facts); deployments outside the ArgoCD app (search-relay) render drift `n/a`
- [x] 2.3 Card render: drop the `build →` step from per-deployment chains (image → gitops → pods → probe); Jenkins card unchanged (display-only: queue, history, last build); `overallStatus` exempts `n/a` from warnings
- [x] 2.4 `storeLastOk(source)`: newest-first scan for the first snapshot without `__error`; `renderFleetOverview` degraded line shows `last ok <true age>` or `never succeeded` — never the failed write's own timestamp
- [x] 2.5 Five-state legend under the agent-fleet header (one dim line, copy from design D5-note): serving = turn in flight · resident = warm & idle · starting/draining/paused · warm = no live process (re-warms on demand)
- [x] 2.6 Unit tests `scripts/test-ops-console-board.mjs` (joins `npm run test:unit`): drift matrix (synced + differing fallback tag → in-agreement; OutOfSync → flagged; no argocd → n/a), `storeLastOk` (error-after-success, never-succeeded), legend present in rendered fleet section (temp SQLite DB + stub snapshots); run full `test:unit` green

## 3. Cluster config (Secret keys)

- [x] 3.1 Patch `ops-console-secrets`: `FLEET_BOARD_URL` `http://fleet-observer:3200` → `http://100.64.0.12:31881` (NodePort, not Service port 3200); add `PROBE_SEARCH_RELAY_URL` = `http://10.43.104.254:4597/healthz`; `kubectl -n fd-prod rollout restart deploy/ops-console`
- [x] 3.2 Verify: fleet overview renders live observer data (states/turns/wake rows populated, no `board read failed`); search-relay card probe ok · ms

## 4. Console code deploy + board acceptance

- [x] 4.1 Re-embed updated `index.js` into `ops-console-code` ConfigMap in `fd-infra-deploy/all-services/prod/ops-console.yaml`, push gitee, ArgoCD sync, `kubectl -n fd-prod rollout restart deploy/ops-console` (subPath never hot-updates)
- [x] 4.2 Acceptance evidence captured of the board: platform probe ok, platform + platform-demo cards `in-agreement`, badge `all nominal` (0 incidents / 0 warnings), fleet overview live, legend visible, search-relay probe ok — captured via board.json + badge HTML in session log (probe: platform ok 7ms / demo ok 9ms / relay ok 6ms)
- [x] 4.3 Regression check: fleet section + billing still render; `/api/board.json` returns `cards[].drift` in the new shape (no `built` field participating)

## 5. Close-out

- [x] 5.1 Probe residual check per test-cleanup discipline (no stray console/dsh test processes)
- [x] 5.2 `openspec validate fix-ops-console-board-alarms --strict` green; archive after burn-in per usual gate (sync specs before archive)
