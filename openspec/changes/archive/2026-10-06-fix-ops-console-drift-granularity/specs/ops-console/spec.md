## MODIFIED Requirements

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
