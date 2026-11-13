# Tasks — fix-ops-console-drift-granularity

## 1. Console: per-deployment drift fact

- [x] 1.1 `services/ops-console/index.js`: `pollK8s` extracts the ArgoCD app's per-resource list (`status.resources[].{kind,name,status}`) into the snapshot (e.g. `argocd.resources`)
- [x] 1.2 `boardModel`: per watched deployment, look up its own `(kind=Deployment, name)` entry → pass `{sync: entry.status}` to `computeDrift`; unlisted non-relay deployments fall back to the app-level status; search-relay keeps n/a
- [x] 1.3 `overallStatus`: app-level sync present and not `Synced` ⇒ exactly one warning (independent of per-card verdicts); vitals argocd chip unchanged

## 2. Tests

- [x] 2.1 `scripts/test-ops-console-board.mjs`: granularity matrix — app OutOfSync + own Synced ⇒ in-agreement; own OutOfSync ⇒ flagged; unlisted ⇒ app-level fallback; search-relay n/a; badge counts one app-level warning
- [x] 2.2 Own file green; run in a clean worktree if other `test:unit` files are churning (shared-tree discipline)

## 3. Deploy + acceptance

- [x] 3.1 Re-embed `index.js` into fd-infra-deploy `ops-console-code` ConfigMap, push gitee, ArgoCD sync, `rollout restart deploy/ops-console`
- [x] 3.2 Live acceptance with the lawcraw drift still up: platform + platform-demo cards `in sync at sha-c0096c2`, badge exactly `1 warning`, vitals chip `OutOfSync`; `/api/board.json` drift statuses match
- [x] 3.3 `openspec validate fix-ops-console-drift-granularity --strict` green; archive after the usual gate
