# ops-console Specification

## Purpose
An internal, read-only web console that assembles the fd deployment health chain — build, image, GitOps, pod, app probe, search-relay quota — into one always-fresh board, replacing the kubectl/ssh/curl workflow that made the 2026-09-26 deploy-day incidents invisible until a human went looking.

## Requirements

### Requirement: The board shows the deployment health chain per service

The console SHALL render one chain card per watched deployment: running image tag → GitOps sync → pod readiness → app-level readiness probe, with each link's live state and the timestamp of its last successful poll. Build-pipeline information SHALL NOT appear on the per-deployment card (it lives on the build-system's own card); drift claims SHALL NOT be derived from it. A link whose poll fails or times out SHALL be shown as failed (not omitted), and the card SHALL stay renderable when any subset of links is unavailable.

#### Scenario: Healthy chain renders green

- **WHEN** every link of a deployment polls successfully
- **THEN** the card SHALL show each link as healthy with its current value (running tag, sync state, pod count, probe result)

#### Scenario: A failed link is visible, not hidden

- **WHEN** one link's poll fails (e.g. the app probe returns an HTTP error)
- **THEN** that link SHALL render as failed with the error's gist and age
- **AND** the remaining links SHALL still render their last-known state with the stale timestamp

### Requirement: Version drift is judged from cluster-internal facts

Each deployment card SHALL derive its drift verdict only from facts observable inside the cluster: the running pod image tag and the GitOps (ArgoCD) sync state — judged, where the ArgoCD application lists the deployment among its resources, by that deployment's OWN resource status rather than the application-wide status, so drift elsewhere in the application SHALL NOT flag an individually-synced deployment. When the application does not list the deployment, the card SHALL fall back to the application-wide status. When the applicable ArgoCD status reports Synced, the card SHALL show the running tag as in agreement (a Synced status means manifest and cluster match by definition). When it reports OutOfSync, the card SHALL flag the deployment as diverging from GitOps. The console SHALL NOT assert build-recency direction against any external build pipeline: since the canonical image pipeline moved off the fallback build system, the newest-built tag is not cluster-observable, and a differing fallback-pipeline tag SHALL NOT raise drift. A watched deployment that is not managed by the ArgoCD application SHALL render its drift field as not-applicable rather than a derived verdict. The overall board status SHALL count the application-wide OutOfSync state as exactly one warning, independent of per-deployment verdicts, so application-level drift stays visible even when every watched deployment is individually in agreement.

#### Scenario: Synced deployment shows agreement even when the fallback build tag differs

- **WHEN** ArgoCD reports Synced, the running pod uses tag T, and the fallback build system's last successful tag is a different, older tag U
- **THEN** the card SHALL show in-agreement at T with no drift indicator

#### Scenario: Out-of-sync application is flagged

- **WHEN** ArgoCD reports OutOfSync for the application covering the deployment
- **THEN** the card SHALL flag the deployment as diverging from GitOps

#### Scenario: Non-GitOps deployment claims no verdict

- **WHEN** a watched deployment is not part of the ArgoCD application (e.g. the search relay)
- **THEN** the card's drift field SHALL render n/a instead of a derived state

#### Scenario: Drift elsewhere in the application does not flag a synced deployment

- **WHEN** the application-wide status is OutOfSync because of resources the console does not watch (e.g. lawcraw), while the watched deployment's own entry in the application's resource list reports Synced
- **THEN** the watched deployment's card SHALL show in-agreement, and the overall badge SHALL count exactly one warning for the application-level divergence

#### Scenario: Deployment missing from the application resource list falls back to app-level status

- **WHEN** a watched deployment (other than a known non-GitOps one) has no entry in the application's resource list
- **THEN** the card's verdict SHALL be derived from the application-wide sync status

### Requirement: The search relay exposes stats for the board

The search relay SHALL expose a stats endpoint (`GET /v1/stats`, same bearer-token authentication as `/v1/search`) returning at least: per-token call counts against the daily cap for the current UTC day, cache hit and miss totals since process start, upstream key failure counts, and response error counts by status class. The endpoint SHALL be read-only and SHALL NOT include key material or token values in its response.

#### Scenario: Stats reflect a day's traffic

- **WHEN** the relay has served cached and fresh searches and one upstream key has failed
- **THEN** the stats response SHALL report those counts such that quota usage, cache hit rate, and key failure are each derivable

#### Scenario: Stats leak no secrets

- **WHEN** the stats response is inspected
- **THEN** it SHALL NOT contain provider API keys or caller token values

### Requirement: Polling snapshots persist for recent history

The console SHALL poll each data source on a fixed cadence (30–60s), store each poll's parsed result as a snapshot in a local SQLite database with at least 7 days of retention, and prune older snapshots. The rendered board SHALL be derived from the latest snapshot set; history SHALL be queryable for the card sparklines (node memory, relay quota usage, Jenkins queue depth).

#### Scenario: Board renders from snapshots, not live calls

- **WHEN** the board page is requested repeatedly
- **THEN** rendering SHALL read the snapshot store without issuing new source polls

#### Scenario: Old snapshots are pruned

- **WHEN** a snapshot ages past the retention window
- **THEN** it SHALL be deleted from the store

### Requirement: Access is authenticated (browser login or token) and strictly read-only

The console SHALL accept exactly two authentication paths: (a) browser login via the operator's OIDC provider (Logto) — authorization-code flow with server-side session cookie, the client credentials and the required-organization ID living only in the deployment Secret; (b) the bearer token for programmatic clients. Unauthenticated requests to board routes SHALL be rejected. Login SHALL be gated by OIDC organization membership: the ID token's organizations claim must contain the configured required organization ID, and admission SHALL fail closed when the claim is absent or membership is missing (the tenant contains end-user accounts from mini-program binding, so "authenticated" alone is not authorization). A tenant-role gate was built first but withdrawn: this Logto build never issues the roles claim in any token despite the console toggle (verified empirically against the live provider). When OIDC is not configured, the console SHALL operate in token-only mode.

#### Scenario: Browser login round-trip

- **WHEN** an unauthenticated browser hits the board and follows the login redirect through the OIDC provider as an allowlisted user
- **THEN** the console SHALL set a session cookie and render the board on the next request

#### Scenario: Organization gate fails closed

- **WHEN** an OIDC-authenticated user is not a member of the required organization, or the organizations claim is absent entirely
- **THEN** the console SHALL refuse the session with an authorization error and no board content

#### Scenario: Unauthenticated request is rejected

- **WHEN** a request arrives without the console's token or a valid session cookie
- **THEN** the console SHALL respond with an authentication error and no board content

#### Scenario: No mutation surface exists

- **WHEN** the console's HTTP surface is enumerated
- **THEN** every route SHALL be a read (board render, snapshot query, login/logout, or stats/probe passthrough of the pollers' own reads)

### Requirement: No secrets live in the repository

All endpoint addresses, tokens, and credentials the console uses SHALL arrive via its environment (mounted from cluster Secrets at deploy time). The repository SHALL contain no real credential values; manifests and examples SHALL carry placeholders only.

#### Scenario: Repository contains no live credentials

- **WHEN** the change's committed files are inspected
- **THEN** no bearer token, provider key, or registry password SHALL appear — only env-var names, Secret references, and placeholder examples


### Requirement: The board shows the agent fleet

The console SHALL render an agent-fleet section fed by the runner's health surface and the platform's billing reads: every deployed agent with its live state (resident / warm / starting / serving / paused / draining), its host runner, its billing key's consumption (spend to date from the runner's metered turns plus the gateway's usage read), and the deployer's balance. A runner or billing read that fails SHALL render that row's values as failed with age, not omit the row. The section SHALL also show the platform's upstream account-pool isolation as a single health line (isolated pool configured and serving, or shared-pool warning). The section SHALL carry a legend that makes the state vocabulary self-describing, including that a live process exists for resident / starting / serving / draining / paused but not for warm (never touched since runner start, or demoted by budget stop / pause — it re-warms on the next request).

#### Scenario: The fleet lists live states

- **WHEN** the console polls with three deployed agents (one serving, one warm, one paused)
- **THEN** the section lists all three with their distinct states and consumption

#### Scenario: A failed read degrades visibly

- **WHEN** the runner health poll fails while billing reads succeed
- **THEN** the agents render with their last-known states marked stale, and the consumption columns still show current reads

#### Scenario: States are self-describing

- **WHEN** the agent-fleet section renders any agent row
- **THEN** a legend SHALL be visible in the section explaining each state's meaning, including that warm means no live process (re-warms on demand) while resident means warm-and-idle with a live process

### Requirement: Degraded sources report truthful recovery age

When a source's latest snapshot is a failed read, any last-success age the board displays for that source SHALL be derived from the most recent snapshot that is not an error — never from the failed write's own timestamp. If no successful snapshot exists, the board SHALL say so explicitly rather than implying a recent success.

#### Scenario: Failed fleet-board read shows the true last success

- **WHEN** the fleet board source fails on every poll after having succeeded an hour ago
- **THEN** the degraded fleet-overview line SHALL report the last successful read as ~1h old (or "never" if no success exists), not the age of the latest failed write

### Requirement: The fleet overview reads the Wanxing observation API

The console SHALL poll the Wanxing fleet observer's board endpoint (`FLEET_BOARD_URL` with the `FLEET_BOARD_TOKEN` service credential) as a `fleetBoard` source and render a fleet overview section ahead of the per-agent table: agent total, five-state distribution, per-runner residency stats (children, memory budget vs limit, queued), wake latency p50/p95, 24h turns/errors/budget-kills/reaped, pending settlements, and per-source ingestion lag (event-age and arrival bases). The section SHALL follow the console's degradation discipline: unconfigured renders an explicit not-configured note, a failed read renders stale/failed with age — never a silently omitted section. The existing per-agent runner-health table remains as the detail view during the transition.

#### Scenario: fleet overview renders from the observer

- **WHEN** FLEET_BOARD_URL is configured and the observer answers
- **THEN** the overview section shows the full first-version metric set, ahead of the per-agent table

#### Scenario: observer unavailable degrades visibly

- **WHEN** the observer is unreachable or unconfigured
- **THEN** the overview section renders a failed/not-configured state with the last data's age, and the rest of the board is unaffected
