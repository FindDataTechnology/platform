# dynamic-cluster-composer Specification

## Purpose

Enables users to assemble custom agent clusters at runtime from installed packs' agents, bind a cluster to a chat session, and keep clusters tidy through usage tracking and warned auto-termination.

## Requirements

### Requirement: Cluster composer UI

The Agents page SHALL offer a 「创建集群」(create cluster) action that opens a composer dialog with: cluster metadata (name required, description and tags optional); agent selection listing the installed packs' agents grouped by pack with multi-select and an 「Add all from pack」shortcut per pack; an activation toggle; and an optional 「绑定到当前会话」(bind to current session) checkbox. Selection is keyed by agent id, so an agent cannot be added twice. Submission SHALL require a name and at least one agent and SHALL show a creation/loading state until the server answers. When the bind option is checked, the dialog SHALL pass the chat store's current session id as the binding key; without a live session the cluster is created unbound.

#### Scenario: Composer dialog opens

- **WHEN** a user clicks create-cluster on the Agents page
- **THEN** a dialog appears with empty metadata fields and the installed packs' agents grouped by pack

#### Scenario: Pack-wide agent addition

- **WHEN** a user clicks 「Add all from pack」for a pack
- **THEN** every agent of that pack is added to the selection

#### Scenario: Empty cluster refused

- **WHEN** a user submits the dialog with no agent selected
- **THEN** the dialog refuses to submit and no cluster is created

### Requirement: My clusters management

The Agents page SHALL list the caller's clusters (name, status, member count) with a 「Manage」action that opens the cluster's detail (members with statuses, creation time) and a 「解散集群」(terminate) action. The list SHALL read `GET /api/clusters/mine` and the detail `GET /api/clusters/:clusterId` using the `clusterId` field as the identifier.

#### Scenario: Manage opens the real detail

- **WHEN** a user clicks Manage on a cluster card
- **THEN** the detail view loads that cluster's members and status, and no request targets an undefined id

### Requirement: Cluster session binding

When a dynamic cluster is created with `bindToSession: true` and a `sessionId` (from the composer, or from the agent picker's load-cluster action), the cluster SHALL be bound to that session: one cluster per session (a newer binding replaces the older one), and the server SHALL broadcast `cluster_bound { clusterId, clusterName, sessionId }`. The chat header of the bound session SHALL show a cluster chip naming the cluster, restored on reload by matching `GET /api/clusters/mine` bindings against the current session id. The picker's load-cluster path additionally switches the runtime to the cluster's first default member so the next message runs under it.

If a bound cluster is terminated (manually or by auto-termination), the server SHALL broadcast `cluster_terminated { clusterId, clusterName, sessionId }`; the bound session SHALL drop the chip, switch the runtime back to the built-in agent, and show a dismissible notice naming the terminated cluster.

#### Scenario: Cluster-bound session

- **WHEN** a user loads a cluster into an open session
- **THEN** the session header shows the cluster chip and the runtime runs under the cluster's first default member

#### Scenario: Binding survives reload

- **WHEN** a client reconnects to a session that has a bound cluster
- **THEN** the chip is restored from the cluster's stored session binding

#### Scenario: Cluster termination during session

- **WHEN** a cluster bound to the open session is terminated
- **THEN** the chip disappears, the runtime switches to the built-in agent, and the user sees a notice naming the cluster

### Requirement: Cluster usage tracking and auto-termination

Every dynamic cluster SHALL track `createdAt`, `lastUsedAt`, `totalExecutions`, and `totalTokensUsed`; executing a cluster task SHALL increment `totalExecutions` and refresh `lastUsedAt` (openspec: scheduling-cluster-aware). These counters SHALL be exposed on `GET /api/clusters/:clusterId`.

A cluster SHALL become an auto-termination candidate when `lastUsedAt` is ≥24h old with `totalExecutions` < 5, or ≥7d old regardless. The hourly scan SHALL broadcast `cluster_expiring { clusterId, clusterName, terminatesAt }` for each new candidate (a bound session's chip shows the deadline), schedule exactly one termination timer per cluster, and after the 1h grace period re-check the candidate: a cluster used during the grace period SHALL survive; a still-idle one SHALL be terminated with the same binding release and `cluster_terminated` broadcast as a manual termination.

#### Scenario: Usage metrics tracked

- **WHEN** a cluster task executes
- **THEN** the cluster's `totalExecutions` increments and `lastUsedAt` is updated

#### Scenario: Low-usage cluster warned then auto-terminated

- **WHEN** a cluster has been unused for 24h with fewer than 5 executions
- **THEN** clients receive `cluster_expiring`, and one hour later the cluster is terminated if it is still idle

#### Scenario: Use during the grace period keeps the cluster

- **WHEN** a warned cluster executes a task before its grace period ends
- **THEN** the pending termination is dropped and the cluster stays `ready`
