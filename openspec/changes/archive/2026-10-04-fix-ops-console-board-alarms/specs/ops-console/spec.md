## MODIFIED Requirements

### Requirement: The board shows the deployment health chain per service

The console SHALL render one chain card per watched deployment: running image tag → GitOps sync → pod readiness → app-level readiness probe, with each link's live state and the timestamp of its last successful poll. Build-pipeline information SHALL NOT appear on the per-deployment card (it lives on the build-system's own card); drift claims SHALL NOT be derived from it. A link whose poll fails or times out SHALL be shown as failed (not omitted), and the card SHALL stay renderable when any subset of links is unavailable.

#### Scenario: Healthy chain renders green

- **WHEN** every link of a deployment polls successfully
- **THEN** the card SHALL show each link as healthy with its current value (running tag, sync state, pod count, probe result)

#### Scenario: A failed link is visible, not hidden

- **WHEN** one link's poll fails (e.g. the app probe returns an HTTP error)
- **THEN** that link SHALL render as failed with the error's gist and age
- **AND** the remaining links SHALL still render their last-known state with the stale timestamp

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

## ADDED Requirements

### Requirement: Version drift is judged from cluster-internal facts

Each deployment card SHALL derive its drift verdict only from facts observable inside the cluster: the running pod image tag and the GitOps (ArgoCD) sync state. When ArgoCD reports the application Synced, the card SHALL show the running tag as in agreement (a Synced application means manifest and cluster match by definition). When ArgoCD reports OutOfSync, the card SHALL flag the deployment as diverging from GitOps. The console SHALL NOT assert build-recency direction against any external build pipeline: since the canonical image pipeline moved off the fallback build system, the newest-built tag is not cluster-observable, and a differing fallback-pipeline tag SHALL NOT raise drift. A watched deployment that is not managed by the ArgoCD application SHALL render its drift field as not-applicable rather than a derived verdict.

#### Scenario: Synced deployment shows agreement even when the fallback build tag differs

- **WHEN** ArgoCD reports Synced, the running pod uses tag T, and the fallback build system's last successful tag is a different, older tag U
- **THEN** the card SHALL show in-agreement at T with no drift indicator

#### Scenario: Out-of-sync application is flagged

- **WHEN** ArgoCD reports OutOfSync for the application covering the deployment
- **THEN** the card SHALL flag the deployment as diverging from GitOps

#### Scenario: Non-GitOps deployment claims no verdict

- **WHEN** a watched deployment is not part of the ArgoCD application (e.g. the search relay)
- **THEN** the card's drift field SHALL render n/a instead of a derived state

### Requirement: Degraded sources report truthful recovery age

When a source's latest snapshot is a failed read, any last-success age the board displays for that source SHALL be derived from the most recent snapshot that is not an error — never from the failed write's own timestamp. If no successful snapshot exists, the board SHALL say so explicitly rather than implying a recent success.

#### Scenario: Failed fleet-board read shows the true last success

- **WHEN** the fleet board source fails on every poll after having succeeded an hour ago
- **THEN** the degraded fleet-overview line SHALL report the last successful read as ~1h old (or "never" if no success exists), not the age of the latest failed write

## REMOVED Requirements

### Requirement: Version drift is detected and surfaced

**Reason**: The requirement mandated comparing the running tag, the latest successful build's tag, and the GitOps manifest tag, and surfacing "a built image that was never rolled". Since the canonical build pipeline moved to the registry-push path (GHA→TCR) with the legacy build system as fallback, the console cannot observe the newest built tag, so the comparison produces a permanent false "newer build not rolled" warning on every deploy that used the canonical path (verified live: running sha-f221a40 vs stale fallback tag sha-6048f89 warned while GitOps and cluster were in perfect agreement).

**Migration**: Superseded by "Version drift is judged from cluster-internal facts" in this change: drift verdicts use the running tag plus the ArgoCD sync state; build-pipeline information moves to a display-only role on the build system's card. The scenario "All in agreement" maps to the new synced-agreement scenario; the two build-lag scenarios are intentionally dropped because the fact they described is no longer observable.
