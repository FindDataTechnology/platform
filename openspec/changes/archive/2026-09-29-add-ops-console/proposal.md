# add-ops-console

## Why

Operating fd-prod is done entirely over `kubectl`/`ssh`/`curl` from one laptop: during the 2026-09-26 deploy day, a wedged Jenkins executor, an offline Harbor, an OOM'd build, and a dsh crash-loop (with container restarts=0 and green liveness) were each diagnosed by hand. Generic k8s dashboards (Rancher/Headlamp/k9s) were evaluated and deliberately excluded from scope: every one of that day's failures lived in the fd-specific layer — build → image → GitOps → pod → app probe → relay quota — which no generic tool assembles. An internal, read-only web console that shows this vertical chain per service is the cheapest way to make "open a page and see today's incident" possible. Internal-only by decision: zero customer-visible surface.

## What Changes

- New internal ops console at `services/ops-console/` — a zero-dependency single-file Node service (the `services/search-relay/` pattern): pollers every 30–60s, snapshots into SQLite (7-day retention), server-rendered single page with auto-refresh. No frontend build chain.
- v1 board: a cluster banner (per-node memory bars, 24h Evicted/OOM event counts, Jenkins queue depth) + vertical chain cards for **platform (fd-prod)**, **platform-demo**, and **search-relay** (git sha → Jenkins build → Harbor image → ArgoCD sync → pod readiness → `/api/ready` app probe; relay card shows key pool, daily quota, cache hit rate, 503 rate) + Jenkins/Harbor status blocks.
- **Version-drift light** on every card: compares the running pod image tag vs the latest successful Jenkins build sha vs the GitOps manifest tag — yellow when the three disagree ("a build exists that was never rolled" / "GitOps lags").
- Prerequisite work: `services/search-relay/index.js` gains a `GET /v1/stats` endpoint (per-token daily counts, cache hits, key failures, 503 counts — the counters already exist in memory; token-gated like `/v1/search`).
- Data sources: k8s API via a dedicated **read-only** ServiceAccount (pods/nodes/events/deployments + the ArgoCD Application CRD — no ArgoCD API/token needed), Jenkins REST (anonymous read, as exercised all deploy day), Harbor `/v2/` health, each deployment's `/api/ready`.
- Deployment: fd-infra-deploy + ArgoCD, code shipped as a ConfigMap on the existing node base image (no CI image of its own); ServiceAccount/RBAC/Secret all cluster-side manifests; access via NodePort + a simple bearer token from an out-of-band Secret.
- Security posture (explicit user requirement): **no credentials or secret material in the repo** — every endpoint address and token arrives via env/Secret; the console is read-only (no exec, no mutations, no restart buttons in v1).
- Non-goals (v2 backlog, recorded not built): fd-staging fleet cards (lawcraw, fd-open-data-mcp, …), a platform `/api/agent/health` endpoint for dsh-deep health (today's crash-loop is invisible to HTTP probes), push alerting, multi-cluster, customer-facing anything, k8s-layer visualization (stay with k9s/Headlamp — orthogonal).

## Capabilities

### New Capabilities

- `ops-console`: the internal operations board — poll-and-snapshot architecture, the v1 card set and what each cell asserts, the version-drift light semantics, the search-relay stats contract it depends on, access control (token-gated, read-only), and the credential-hygiene rules (no secrets in repo, out-of-band Secret).

### Modified Capabilities

(none — the relay `/v1/stats` endpoint is a new surface owned by this capability, not a change to the platform-facing `web-search` contract; nothing in an existing spec's observable behavior changes.)

## Impact

- New tree `services/ops-console/` (service + docs); one endpoint added to `services/search-relay/index.js` (additive, token-gated, no behavior change to `/v1/search`).
- Cluster-side (fd-infra-deploy repo, separate from this change's code): Deployment + ConfigMap code + NodePort Service + read-only ServiceAccount/RBAC (namespaces fd-prod, jenkins, harbor, argocd) + ops-console Secret (token + endpoint env). None of it carries real values in git.
- Operational cost target: <100 MB RAM, one small pod; polling cadence sized to keep Jenkins/Harbor load negligible.
- Tests: a hermetic harness for the snapshot/render logic with stubbed sources (the e2e suite does not boot the console — it is not part of the app).
