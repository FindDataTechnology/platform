# add-ops-console — Design

## Context

See `proposal.md` for motivation (the 2026-09-26 incident catalog) and the exploration record: the cluster has no monitoring stack; the existing `/settings/status` and `/trace` pages are per-cell user surfaces, not operator surfaces; Jenkins REST was exercised anonymously all deploy day; ArgoCD state is readable as the `Application` CRD — no ArgoCD API token needed; the search relay keeps its counters in memory with no export endpoint. The k8s-visualization half of "manage & monitor" was explicitly moved out of scope (k9s/Headlamp, chosen independently); Rancher was rejected as heavyweight and, critically, as unable to assemble the fd-specific chain anyway.

## Goals / Non-Goals

**Goals:**

- One internal page where the 2026-09-26 class of failure (Jenkins wedge, Harbor offline, image-GC, crash-loop-with-green-container, version drift) is visible on arrival.
- Cheap to own: zero npm dependencies, zero frontend build, one small pod, one SQLite file, deploy-by-ConfigMap.
- Strictly read-only and secret-free in git.

**Non-Goals:**

- Anything mutating (restart/trigger/exec) — even later versions should treat this as a separate, deliberately gated decision.
- dsh-deep health (needs a platform endpoint; v2), fd-staging fleet cards (v2), push alerting (v2), multi-cluster, auth beyond the bearer token.
- Generic k8s browsing — delegated to k9s/Headlamp.

## Decisions

### D1: Single-file service in `services/ops-console/`, not a page in the product app

The `services/search-relay/` precedent: operator tooling lives in the repo but ships separately (ConfigMap code on the Harbor node base image), so internal knowledge (Jenkins/Harbor addresses, board layout) never enters the product image, the console's restarts never touch prod, and it keeps its own lifecycle. **Alternative rejected**: an `/ops` route in the web SPA — couples internal ops to the customer product, drags Jenkins/Harbor config into product env, and dies with the pod it monitors (today's crash-loop would have taken the board with it).

### D2: Poll-and-snapshot with SQLite; render never touches sources

One `poll()` loop per source on a 30–60s cadence writes parsed snapshots to SQLite (`snapshots(source, key, ts, json)` + `prune(ts < now-7d)` on each cycle). `GET /` renders from the latest snapshot set only. Consequences: page refreshes are free; a source being down shows as a stale/failed cell instead of a hung page; history for sparklines (node memory, relay quota, queue depth) comes from the same table. **Alternative rejected**: render-time live fan-out — makes the page latency-coupled to five upstreams and un-renderable during incidents, exactly when it must work.

### D3: Kubernetes via dedicated read-only ServiceAccount; ArgoCD via CRD, Jenkins via anonymous REST

RBAC: one `ops-console` ServiceAccount with `get/list/watch` on `pods`, `nodes`, `events`, `deployments` in the watched namespaces (fd-prod, jenkins, harbor, argocd) — nothing cluster-wide, no secrets, no exec, no writes. GitOps state = `applications.argoproj.io` in the argocd namespace (sync status + manifest image tag), read with the same SA. Jenkins: the queue/job JSON endpoints exercised anonymously all deploy day; the console uses the same reads. Harbor: `/v2/` unauthenticated reachability + the harbor-core pod state from the k8s poller (deep Harbor metrics are v2 if ever needed). All endpoint addresses via env (`JENKINS_URL`, `HARBOR_URL`, watched-deployment list), values living only in the cluster Secret.

### D4: Version-drift light from two tags + the sync state, no new APIs

The facts — running tag (pod spec image), latest build tag (Jenkins lastSuccessfulBuild's console `Pushed …:sha-<7>` line) — are readable today, plus the ArgoCD `Application` CRD's sync status. **Correction from implementation:** the Application CRD does NOT embed the rendered manifest, so the GitOps manifest tag cannot be read from it without a separate ArgoCD-API credential; it is derived instead — when `sync=Synced` the manifest equals the live cluster (running == manifest), and `OutOfSync` marks them as differing. The observable outcomes map 1:1 to the spec's scenarios: newer build unrolled (running != built, Synced), cluster diverging (OutOfSync), agreement. **Alternative rejected**: fetching the manifest via the ArgoCD server API — a whole new credential for one string.

### D5: relay `/v1/stats` — additive, token-gated, redacted

The relay already tracks per-token day counters, cache Map, key cooldowns, and serves them nowhere. `GET /v1/stats` returns aggregates keyed by token *prefix* and key *index* (never raw values), same bearer gate as `/v1/search`. Additive to `services/search-relay/index.js`; no change to `/v1/search` behavior, so the `web-search` spec is untouched.

### D6: Access = NodePort + bearer token, following the Jenkins internal-tool pattern

Env `OPS_CONSOLE_TOKEN` (from the cluster Secret) gates every request including the board page. No Logto: internal-only tooling, not publicly linked, same posture as the Jenkins NodePort that already exposes build logs. Recorded consciously: if teammate access or zero-click security is ever needed, front it with the existing Caddy + Logto path rather than growing auth into the console.

### D7: Rendered page, zero frontend build

Server-side string-template single page: cluster banner (per-node memory bars from `nodes` + `metrics.k8s.io` if the metrics-server API is reachable via the SA — degrade to a plain "n/a" cell if not), cards, drift lights, one `meta refresh` tag (30s), minimal inline CSS. **Alternative rejected**: a Vite/React mini-app — a build chain and a second artifact for a board with no interactivity; revisit only if interactivity arrives (v2 history views).

## Risks / Trade-offs

- [Read-only SA still reads events/logs metadata across fd-prod] → namespace-scoped RoleBindings only; the SA is namespaced to exactly the four watched namespaces.
- [Polling Jenkins/Harbor adds load] → 30–60s cadence, single-flight polls, no retries on failure (next cycle retries naturally).
- [Board itself is a new small surface on a busy node] → memory target <100 Mi, no NodePort exposure beyond the internal pattern; it can also be scaled to zero when unused (polls stop, board goes stale — visible as such).
- [Drift light false-positives when Jenkins builds non-deployable branches] → compare only the watched jobs' `lastSuccessfulBuild` against the GitOps repo's known job; a mismatch in *which* job feeds a manifest is a deploy-time config row, not runtime logic.
- [Single-file service grows tangled] → hard internal seams (sources / store / render as clearly separated sections); if it exceeds ~1500 lines, split files before adding features.

## Migration Plan

1. Ship relay `/v1/stats` (additive; roll the relay pod — no platform dependency).
2. Ship the console code + cluster manifests (SA/RBAC, Secret with placeholders documented, ConfigMap, Deployment, NodePort Service) via fd-infra-deploy + ArgoCD.
3. Rollout verification: unauthenticated request → 401; authenticated board renders with live green cells; every card cell shows a fresh timestamp.
4. Rollback: delete the console Deployment/Service (board gone, nothing else depends on it); relay stats endpoint is harmless to leave.

## Open Questions

- Whether `metrics.k8s.io` (metrics-server) is readable through the SA in this k3s — if not, node memory bars degrade to "n/a" in v1 (resolved at deploy time, not blocking).
- Sparkline granularity (raw snapshots vs hourly downsample for the 7-day window) — resolve at implementation from actual row volumes.

### D8: Browser login via a dedicated Logto application (added after first live use)

Bearer tokens are for curl, not browsers. The console gains the platform's own login pattern (see `server/logto-auth.js`) in a self-contained form: a NEW confidential "Traditional Web" application in the same Logto tenant, authorization-code flow with a signed state cookie, token exchange server-side, and an HMAC-signed session cookie. Differences from the platform's implementation, deliberately: identity is verified by calling the provider's userinfo endpoint with the exchanged access token instead of verifying the ID-token signature locally (the console is a single zero-dependency file; porting JWKS/RSA verification is not worth it — the userinfo call over TLS to the trusted provider is the verification). Authorization is an email allowlist from the Secret that FAILS CLOSED when unset — the tenant carries end-user accounts created by mini-program binding, so "authenticated" must not imply "operator". The bearer token stays as the programmatic path; when OIDC env is absent the console runs token-only (previous behavior).

Client credentials (LOGTO_APP_ID/LOGTO_APP_SECRET), SESSION_SECRET, OPS_PUBLIC_URL, and OPS_ALLOWED_EMAILS live only in the cluster Secret. The Logto application itself is created by the operator in the Logto console (Management-API credentials are not held by this repo) with redirect URI `{OPS_PUBLIC_URL}/auth/callback`.

### D9: Role-based admission (replaces the email allowlist, added at user request)

A tenant role `ops-console` (User type) is the single admission gate; the Logto console's ID-token claims page (customize-jwt) has a stock `roles` toggle — no custom-JWT script, no Management-API M2M app — so the roles claim reaches the userinfo response and the console checks membership at callback, failing closed on a missing claim. The email allowlist was removed (it duplicated the same decision with worse ergonomics: adding a person now means assigning the Logto role, visible and auditable next to every other permission in the tenant).

### D10: Organization membership, not tenant roles (D9 withdrawn)

The D9 tenant-role gate shipped and was verified against the live provider with a hand-driven authorization-code probe: this Logto build (v1.42) NEVER issues the `roles` claim — not in the ID token, not at the userinfo endpoint, under `roles`, `urn:logto:scope:roles`, or default scopes — despite the console's claims toggle reading "on" after save. The claim machinery that DOES work in this tenant is `organizations` (scope `urn:logto:scope:organizations`; the platform's own group gating rides it), so the gate became membership in a dedicated Logto organization (name `ops-console`, ID in the deployment Secret as `OPS_REQUIRED_ORG`). Admission reads the organizations claim from the decoded id_token payload; adding a person is now a Logto-console membership operation, auditable next to every other tenant permission.
