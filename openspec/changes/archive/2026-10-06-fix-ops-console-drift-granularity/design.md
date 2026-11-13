# Design — fix-ops-console-drift-granularity

## Live evidence (2026-10-06)

- ArgoCD `all-services-prod`: app-level **OutOfSync**, caused solely by law-bench/lawcraw resources (2 ConfigMaps + 2 Services + 2 Deployments, another workstream's in-flight state).
- platform + platform-demo per-resource status: **Synced** (both at sha-c0096c2, matching GitOps `2fb5234`).
- Board: both platform cards render "cluster diverges from GitOps", badge `2 warnings` — false attribution via app-level status.
- `pollK8s` already fetches the full Application JSON and keeps only `{sync, health}`; the per-resource list (`status.resources[].{kind,name,status}`) arrives in the same payload and is discarded.

## Decisions

- **D1 — Own-resource status as the drift fact**: `pollK8s` extracts `resources: [{kind, name, status}]` from the app payload; `boardModel` looks up `(kind=Deployment, name=<watched>)` and passes `{sync: <status>}` to `computeDrift` in place of the app-level object. Status vocabulary is ArgoCD's own (`Synced`/`OutOfSync`/`Progressing`…), so `computeDrift`'s `Synced ⇒ in-agreement, else cluster-out-of-sync` logic is unchanged.
- **D2 — App-level fallback when unlisted**: if the app exists but the deployment has no resource entry (and it is not the known non-GitOps search-relay), use the app-level status. Covers an app listing that lags or a manifest just added.
- **D3 — The badge counts app-level drift once**: `overallStatus` adds `warn += 1` when the app-level sync is present and not `Synced`. Rationale: with per-card precision, watched cards can all be clean while the cluster genuinely diverges — the one-dot summary must not go green over an unwatched deployment's drift. The vitals argocd chip already shows the app-level word and stays as-is. Net effect with the lawcraw drift live: badge `1 warning` (down from 2), cards `in-agreement`.
- **D4 — Console-only deploy**: re-embed `index.js` into the fd-infra-deploy ConfigMap, push gitee, rollout restart. No platform image (established by fix-ops-console-board-alarms).

## Testing

- Unit (`scripts/test-ops-console-board.mjs`): granularity matrix — app OutOfSync + own resource Synced ⇒ in-agreement; own resource OutOfSync ⇒ flagged; unlisted deployment ⇒ app-level fallback; search-relay ⇒ n/a unchanged. `overallStatus` may need its own export if the badge rule is asserted directly, else assert via the existing render path with stub snapshots.
- Live acceptance: board shows platform/platform-demo `in sync at sha-c0096c2`, badge exactly `1 warning`, vitals argocd chip `OutOfSync` — with the lawcraw drift untouched (it belongs to the other workstream; do not sync it).

## Risks

- ArgoCD resource-list semantics: entries are per-Git resource; a watched deployment listed under a different app would not be found → falls back to app-level of THIS app, which could mis-flag. Accepted: single-app deployment layout is the live reality (all-services-prod covers every watched GitOps deployment).
- None downstream: the drift status vocabulary and card rendering are unchanged; unit tests pin the matrix.
