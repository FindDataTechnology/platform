# add-ops-console — Tasks

## 1. Relay stats endpoint (prerequisite)

- [x] 1.1 Add `GET /v1/stats` to `services/search-relay/index.js` — same bearer gate as `/v1/search`; response carries per-token (by prefix) current-day call counts vs cap, cache hit/miss totals, per-key-index failure counts, and error counts by status class; assert via the existing stub harness that keys/token values never appear in the response and that `/v1/search` behavior is unchanged

## 2. Console core (sources, store, render)

- [x] 2.1 Create `services/ops-console/index.js` skeleton: env config loader (all endpoints/tokens from env; refuse to start without `OPS_CONSOLE_TOKEN`), bearer gate on every route, `GET /healthz` unauthenticated 401-free minimal liveness for the pod probe; verify a curl without token gets 401 and `/healthz` answers
- [x] 2.2 Implement the SQLite snapshot store (open-at-boot, `snapshots` table, upsert-latest-per-source write, prune older than 7 days each cycle, read-latest API for the renderer); verify with a temp DB that write→read-latest→prune round-trips
- [x] 2.3 Implement the k8s source (in-cluster SA: list pods/deployments in watched namespaces, list nodes, recent events filtered to Warning, read `applications.argoproj.io` in the argocd namespace for sync status + manifest image tag; read `metrics.k8s.io` node usage when available, degrade to n/a); verify against a stubbed k8s API server harness that parsing handles missing metrics and missing Application
- [x] 2.4 Implement the Jenkins source (queue length, watched jobs' lastBuild/lastSuccessfulBuild number + result + running flag, resolve the pushed image tag from the build metadata); verify against a stub Jenkins harness including the wedged-executor state (queue > 0, nothing building)
- [x] 2.5 Implement the platform probes source (per watched deployment: `GET /api/ready` + `/api/config` with short timeouts) and the relay stats source (`GET /v1/stats`); verify both cells fail soft (stale, not crash) when the target is down, via the stub harness
- [x] 2.6 Implement the version-drift computation (running tag vs manifest tag vs latest successful build tag; name the laggard); verify the three scenarios from the spec (stale pod, lagging manifest, agreement) with fixture snapshots
- [x] 2.7 Implement the rendered board: cluster banner (node memory bars, 24h Evicted/OOM counts, Jenkins queue depth), three chain cards, Jenkins/Harbor blocks, drift lights, stale-timestamp rendering for failed links, 30s meta-refresh, inline CSS; verify the page renders green from all-green fixtures and renders failed/stale cells correctly from degraded fixtures

## 3. Cluster manifests (fd-infra-deploy repo)

- [x] 3.1 Write `ops-console.yaml`: read-only ServiceAccount + RoleBindings (fd-prod, jenkins, harbor, argocd: get/list/watch on pods, nodes, events, deployments, applications), ConfigMap carrying the code, Deployment (node base image, <100 Mi target), NodePort Service, Secret placeholder note (real token created out-of-band); verify `kubectl apply --dry-run=client` validates and no real credential appears in the file
- [x] 3.2 Create the out-of-band Secret (console token + source endpoint envs) on the cluster; verify the manifest's secretKeyRefs resolve

## 4. Verification and docs

- [x] 4.1 Hermetic harness for the console: boot it against stub sources, assert the six spec scenarios (healthy chain, failed link visible, both drift cases + agreement, unauthenticated 401, no-mutation surface, repo-secret-free grep over the change's files); all green
- [x] 4.2 Deploy to the cluster via ArgoCD and verify live: board renders with fresh timestamps against real fd-prod, drift light matches the actual deployed shas, relay card reflects real quota counters, Jenkins block shows the real queue depth; record the node-memory availability answer (metrics-server readable or n/a) in the manifest comment
- [x] 4.3 Document the operator runbook in DEPLOY.md (ops-console section: env contract, where the Secret lives, how to read the drift light, rollback = delete deployment); verify a fresh reader can locate the board URL and token source from the doc alone

## 5. Browser login via Logto (added after first live use)

- [x] 5.1 Implement OIDC login in `services/ops-console/index.js`: authorization-code flow against a dedicated Logto app (discovery at boot, signed state cookie, server-side token exchange, userinfo-call verification, HMAC-signed session cookie), email allowlist failing closed when unset, `/auth/logout`; bearer token retained as the programmatic path; verify with a stub-OIDC harness that the full redirect→callback→cookie round-trip renders the board, that a non-allowlisted email is refused, that an unset allowlist refuses everyone, and that bearer-only mode still works
- [x] 5.2 Operator creates the Logto "Traditional Web" application (redirect URI `{OPS_PUBLIC_URL}/auth/callback`) and patches `ops-console-secrets` with LOGTO_ENDPOINT/LOGTO_APP_ID/LOGTO_APP_SECRET/SESSION_SECRET/OPS_PUBLIC_URL/OPS_ALLOWED_EMAILS; roll the console and verify a real browser login renders the board

## 6. Role-based admission (D9)

- [x] 6.1 Gate login on Logto membership, fail closed — BUILT AS ORGANIZATION MEMBERSHIP, not the tenant role first attempted: this Logto build never issues the roles claim (verified live with a hand-driven OIDC probe across three scope variants); organization `ops-console` (ID tvs6wkjtn8ic) created, operator added, authorize scope carries urn:logto:scope:organizations, admission checks the id_token organizations claim; harness 11/11 (member/non-member/missing-claim/unset-org) and live-verified both directions (member renders the board, wrong required org refused 403, restored renders again)
