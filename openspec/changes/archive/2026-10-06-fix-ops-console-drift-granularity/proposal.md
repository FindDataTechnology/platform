# fix-ops-console-drift-granularity

## Why

The board's drift verdict uses the ArgoCD **application-wide** sync status, so one unwatched deployment drifting (law-bench/lawcraw, another workstream's in-flight state, live since 2026-10-05) flags every watched card: platform and platform-demo render "cluster diverges from GitOps" and the badge counts 2 warnings while both deployments are per-resource **Synced** at the GitOps tag. The ArgoCD app resource already carries per-resource statuses — the k8s poller fetches them today and discards them. False attribution on a health board is the same disease fix-ops-console-board-alarms cured: the operator either chases a non-issue on platform or learns to ignore the badge.

## What Changes

- **Per-deployment drift fact** — each watched deployment's drift verdict uses its own entry in the ArgoCD application's resource statuses (kind=Deployment, same name) instead of the app-wide status. A deployment absent from the resource list falls back to the app-level status (honest when the listing is incomplete). search-relay keeps its n/a (not GitOps-managed).
- **App-level divergence keeps counting once** — the overall badge gains a single warning when the ArgoCD application reports OutOfSync, so cluster-level drift stays visible at the "one dot a tired operator reads first" even when every watched card is individually clean; the vitals strip's argocd chip keeps showing the app-level sync word as it does today.
- **Deploy is console-only** — no image rollout; re-embed the ConfigMap, restart the console.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `ops-console`: the version-drift requirement gains per-deployment granularity (own-resource status, app-level fallback) and an application-level badge rule; the gitops chain link keeps rendering the app-level word.

## Impact

- **Code**: `services/ops-console/index.js` — pollK8s extracts per-resource statuses; boardModel/computeDrift consume the deployment's own status; overallStatus counts app-level OutOfSync once. No other file changes.
- **Tests**: `scripts/test-ops-console-board.mjs` — new cases for the granularity matrix.
- **Deploy**: fd-infra-deploy ConfigMap re-embed + rollout restart (the established console path; no platform image).
- **Acceptance**: with the lawcraw drift still live, platform + platform-demo cards show in-agreement at sha-c0096c2, the badge shows exactly 1 warning attributable to the app-level drift (vitals argocd chip OutOfSync), and the card-level false attribution is gone.
