# Tasks — fix-gateway-sigterm-graceful-shutdown

## 1. Fix + local proof

- [x] 1.1 `gateway/index.js`: hoist `packRegistry` to module-scope `let` (assign in the pack-mode branch, drop `const`); wrap `shareRegistry.close()` and `packRegistry.close()` in isolated try/catch with an error log; fix the two mis-indented handler lines
- [x] 1.2 Local boot check: boot the gateway (CELL_GATEWAY_SECRET, temp CELL_DATA_ROOT, free port) → SIGTERM → exit 0, `stopping 0 cell(s)` logged, no ReferenceError (the discovery recipe, now green)
- [x] 1.3 Mode sanity: boot with `FACET_BASE_URL` set (facet-proxy mode) → SIGTERM → still exits cleanly through the null-guarded branch

## 2. Regression coverage

- [x] 2.1 `scripts/test-cell-gateway.mjs`: after the existing subtests, SIGTERM the booted gateway — assert exit code 0, the cell-stop log line, and no unhandled-rejection text in captured logs
- [x] 2.2 Run the file in a clean git worktree (shared-tree churn makes cell-dependent verdicts unreliable in the main tree); full `node --test scripts/test-cell-gateway.mjs` green there; own-file also green in main tree
- [x] 2.3 Remove the worktree and any stray gateway/cell test processes afterward (test-cleanup discipline)

## 3. Release + live verification

- [x] 3.1 Commit (gateway/index.js + test + change artifacts) and push; wait for the `image` GHA run to succeed
- [x] 3.2 fd-infra-deploy double bump: `platform.yaml` + `platform-demo.yaml` → new sha tag (also carries 07cb7f7's mobile fix to demo); push gitee; wait ArgoCD Synced and both deployments rolled
- [x] 3.3 Verify: replaced pod's termination shows the graceful path (no `packRegistry` ReferenceError, exit 0); new pods `/healthz` 200; ops board remains `all nominal`
- [x] 3.4 `openspec validate fix-gateway-sigterm-graceful-shutdown --strict` green before archive; archive after burn-in per usual gate

> Apply annotations (2026-10-05 UTC): 3.2 needed two attempts — the first bump raced the tcr-relay (hkccr→ccr every-5-min skopeo cron on cheap-3) and pods hit ImagePullBackOff `not found`; with the Recreate strategy that is a full outage (~14 min), recovered by rollback to sha-07cb7f7, then re-bump after confirming the landing via `tcr-relay.log OK` + skopeo on cheap-3. Lesson: **bump only after the relay logs OK for the tag**. 3.3 evidence: SIGTERM to PID 1 of the running fixed pod → previous-container log ends `[gateway] SIGTERM — stopping 1 cell(s)` / `cell … stopping (gateway shutdown)`, no ReferenceError, container cleanly restarted, `/healthz` 200. Board badge reads `2 warnings` from a REAL unrelated drift (law-bench/lawcraw OutOfSync, another workstream's in-flight state); platform + platform-demo are per-resource **Synced** at sha-c0096c2 — the app-level drift wording inherited by all cards is a known granularity limit, left as-is.
