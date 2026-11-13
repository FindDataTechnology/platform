# fix-ops-console-board-alarms

## Why

The ops board's alarms have been lying since the 2026-10-01 cells cutover: the `platform` probe is permanently red (the gateway never exposed an anonymous `/api/ready`, so the probe gets 401), the drift card permanently warns "newer build not rolled" (the console still treats Jenkins as the build fact source, but the canonical pipeline moved to GHA→TCR on 09-30 — the newest-build fact is simply not cluster-observable), and the fleet overview both fails on an unresolvable `fleet-observer` hostname and mislabels the failed read's own timestamp as "last ok". A health board whose alarms are chronically false is worse than no board — the operator learns to ignore it, and real incidents hide in the noise.

## What Changes

- **platform probe re-points at the gateway's `/healthz`** — the gateway is the `platform` deployment since the cells cutover, and `/healthz` (process readiness + cell count, anonymous) is the correct depth for that deployment. An earlier draft added a gateway `/api/ready` alias; it was reverted because `/api/ready` through the gateway is load-bearing: the catch-all proxies it to the caller's cell, whose `/api/ready` reports dsh-agent boot depth (503 while booting) — a shallow gateway route would shadow that per-user deep contract (falsified by `test-cell-gateway`'s `waitForCellReady`, which polls the gateway path with a cookie).
- **Drift judgment becomes cluster-internal-facts-only** — per-deployment cards compare the running image tag with the ArgoCD sync state; the Jenkins build tag no longer participates in drift. The `newer-build-not-rolled` state is deleted (it asserted a direction the console cannot know). The build step leaves the per-deployment chain; Jenkins stays as a display-only card (build history, queue).
- **Failed source reads report the true last-success age** — the degraded fleet-overview line derives "last ok" from the most recent non-error snapshot (or says never), not the failed write's own timestamp.
- **Five-state legend** — a one-line dim legend in the agent-fleet section explaining paused/draining/starting/serving/resident and that warm means "no live process" (never touched or budget-demoted). Naming in the runner is untouched.
- **Two cluster-config fixes (deployment tasks, not spec)** — `FLEET_BOARD_URL` → `http://100.64.0.12:31881` (wanxing-observer NodePort; the current value is an in-cluster Service DNS name the console pod cannot resolve — it runs `dnsPolicy: Default` — and even an IP-literal fix would need the NodePort 31881, not the Service port 3200); `PROBE_PLATFORM_URL` → `http://100.64.0.12:31870/healthz` and `PROBE_SEARCH_RELAY_URL` → `http://10.43.104.254:4597/healthz` (same ClusterIP base the working `RELAY_URL` already uses).

Out of scope: the billing `n/a` for the demo pack's deployer (a data-layer gap in the billing board's balances, to be investigated separately).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `ops-console`: the deployment-chain card loses its build link; the version-drift requirement is reshaped (old requirement removed, new one added) to cluster-internal facts; the agent-fleet section gains a states legend; a new requirement covers truthful last-success ages on degraded reads.

## Impact

- **Code**: `services/ops-console/index.js` (drift computation, card render, fleet-overview degraded line, legend, import-safety main-guard so pure functions are unit-testable). No gateway change ships.
- **Tests**: new `scripts/test-ops-console-board.mjs` (drift matrix, last-ok scan) — runs under the existing `test:unit` glob.
- **Deploy (two legs, no image rollout)**: console code is re-embedded into the `ops-console-code` ConfigMap in `fd-infra-deploy/all-services/prod/ops-console.yaml` then rollout-restart (subPath ConfigMaps do not hot-update, and a bare kubectl ConfigMap edit would be reverted by ArgoCD); three Secret keys (`FLEET_BOARD_URL`, `PROBE_PLATFORM_URL`, `PROBE_SEARCH_RELAY_URL`) via kubectl + rollout restart. The platform image is untouched — the console runs from a ConfigMap on a stock node image, and the gateway needs no change.
- **Acceptance**: one board pass — platform probe ok, both platform cards in-agreement, badge "all nominal", fleet overview rendering live observer data, legend visible, search-relay probe ok.
