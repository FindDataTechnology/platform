# agent-cluster-core Specification

## Purpose

Defines the cluster abstraction that unifies packs, agents, and their relationships — a pack MAY declare a small team (≤3 agents by the pack limits) as a shareable cluster template, the catalog marks its members, the chat agent picker groups them, and users assemble ad-hoc dynamic clusters from any installed packs' agents. Dynamic clusters are cell-local and session-bindable; execution fan-out is the scheduling plane's job (openspec: scheduling-cluster-aware).

## ADDED Requirements

### Requirement: Pack manifest supports cluster metadata

Each pack MAY declare a top-level `cluster` object:

```yaml
cluster:
  name: string            # Human-readable cluster name (required, ≤500 chars)
  description: string     # Cluster description (required, ≤500 chars)
  defaultAgents: string[] # Agent ids activated by default (non-empty)
  optionalAgents?: string[] # Additional members available but not default
  schedulingPolicy?: { maxConcurrentRuns?: number }  # positive integer ≤10
```

The `cluster` field is OPTIONAL; packs without it are ordinary packs. When present: `name` and `description` MUST be non-empty; `defaultAgents` MUST be non-empty and reference only agent ids declared in the pack's `agents` array; `optionalAgents` MUST reference declared agents and MUST NOT repeat `defaultAgents`; `schedulingPolicy.maxConcurrentRuns` MUST be a positive integer ≤10. Publishing SHALL reject a malformed `cluster` block naming the offending field. The pack-level limits (agents ≤3, mcpServers ≤5, skills ≤10) apply unchanged — a cluster pack is a small-team template; larger teams are assembled as dynamic clusters. Member agents keep their focused resource sets through the existing per-role `resources` declaration (openspec: pack-agent-scoping), so a bundled team never widens a member's tool face.

#### Scenario: Valid cluster metadata accepted

- **WHEN** a pack manifest includes a well-formed `cluster` object
- **THEN** publish and `/api/packs/validate` accept it and the metadata is stored alongside the manifest

#### Scenario: Missing required fields rejected

- **WHEN** a pack manifest declares `cluster.name` but omits `cluster.description` or `cluster.defaultAgents`
- **THEN** validation fails naming the missing field

#### Scenario: Invalid agent reference rejected

- **WHEN** `cluster.defaultAgents` or `cluster.optionalAgents` names an agent id not declared in the pack's `agents`
- **THEN** validation fails naming the offending agent id

#### Scenario: Excessive concurrency limit rejected

- **WHEN** `cluster.schedulingPolicy.maxConcurrentRuns` is not a positive integer ≤10
- **THEN** validation fails naming the field

### Requirement: Agent catalog marks pack-sourced agents with cluster fields

Every chat-mode `agent-remote` catalog entry sourced from an installed pack that declares `cluster` metadata SHALL carry `clusterId` (the source pack id), `clusterName` (the pack's `cluster.name`, falling back to the pack display name), and `isDefaultAgent` (`true` when the agent id appears in `cluster.defaultAgents`). Entries from packs without cluster metadata, built-in entries, and registry-sourced entries SHALL NOT carry these fields. The fields SHALL ride both `GET /api/catalog` and the `agents` WebSocket message unchanged.

#### Scenario: Pack-sourced agent carries cluster fields

- **WHEN** a user installs a pack with cluster metadata and fetches the catalog
- **THEN** that pack's agents appear with `clusterId`, `clusterName`, and `isDefaultAgent`

#### Scenario: Shadowed member keeps its original pack's identity

- **WHEN** a cluster pack declares an agent id already installed from another pack
- **THEN** the existing installation wins (install reports the member as skipped) and the catalog entry keeps the earlier pack's fields, so the cluster group shows only the members actually installed from the cluster pack

### Requirement: Cluster-aware agent picker

The chat control strip's agent menu SHALL group pack-sourced agents that carry a `clusterId` under a cluster header showing the cluster name and member count, listing default members before optional ones; agents without a cluster keep their flat order. Each cluster header SHALL offer a 「载入集群」(load cluster) action. Because the shared runtime hosts one persona at a time, loading a cluster SHALL mean: create a dynamic cluster from the group's members bound to the current session (openspec: dynamic-cluster-composer, Cluster session binding) and switch the runtime to the first default member; it SHALL NOT claim to activate several personas at once — concurrent member execution is the cluster task surface (openspec: scheduling-cluster-aware). The picker lists installed agents only, so no install step is involved.

#### Scenario: Cluster grouping in picker

- **WHEN** a user installs a cluster pack and opens the agent menu in a chat session
- **THEN** the pack's installed members are grouped under a header naming the cluster and its member count, default members first, with a load-cluster action

#### Scenario: Loading a cluster binds the session and switches to the lead

- **WHEN** the user triggers load-cluster inside an open session
- **THEN** a dynamic cluster bound to that session is created, the session header shows the cluster, and the runtime switches to the first default member

### Requirement: Dynamic cluster assembly API

The platform SHALL expose `POST /api/clusters/dynamic` for authenticated users (the machine owner when auth is off) to create ad-hoc clusters from installed packs' agents:

```json
{
  "name": "My Analysis Team",
  "description": "optional",
  "tags": ["optional"],
  "agents": [ { "packId": "_abc", "agentId": "finance-bot" }, { "packId": "_def", "agentId": "data-analyst" } ],
  "bindToSession": true,
  "sessionId": "session_789"
}
```

The endpoint SHALL validate that every referenced pack is installed in the cell (a missing one is reported as `not_subscribed` naming the agent), require a non-empty name and at least one agent, rate-limit creation to 10 per hour per user, and answer with `clusterId`, `status` (`ready` when every member's pack is installed, else `loading`), and the members with their individual statuses. When `bindToSession` is set together with a `sessionId`, the cluster SHALL be bound to that session (openspec: dynamic-cluster-composer). Clusters are stored per cell in a durable store that survives restarts.

#### Scenario: Dynamic cluster creation succeeds

- **WHEN** an authenticated user creates a dynamic cluster from two installed packs' agents
- **THEN** the endpoint returns `status: "ready"` with both members marked active

#### Scenario: Uninstalled pack refused

- **WHEN** the request references an agent whose pack is not installed in the cell
- **THEN** the endpoint rejects with 400 naming the agent and `not_subscribed`

#### Scenario: Auth-off deployments serve the machine owner

- **WHEN** a deployment runs without authentication and the cluster routes are called
- **THEN** the requester is the machine owner identity, consistent with the pack market's auth-off semantics — never a 401

### Requirement: Cluster lifecycle management

Dynamic clusters SHALL have the lifecycle states `creating` (members' packs still installing), `ready`, and `terminated`. The platform SHALL expose `GET /api/clusters/mine` (the caller's clusters with id, name, status, member count, bound session id, timestamps), `GET /api/clusters/:clusterId` (metadata, status, members, usage counters), `PATCH /api/clusters/:clusterId` (name/description/tags), `POST /api/clusters/:clusterId/agents` and `DELETE /api/clusters/:clusterId/agents/:agentId` (membership), and `DELETE /api/clusters/:clusterId` (terminate: mark terminated, release the session binding, broadcast `cluster_terminated`). Terminated clusters SHALL be excluded from listings. Idle clusters SHALL be auto-terminated per the usage-tracking rules in dynamic-cluster-composer.

#### Scenario: Cluster status retrieval

- **WHEN** a user calls `GET /api/clusters/:clusterId`
- **THEN** the response includes name, status, members with statuses, creation time, and usage counters

#### Scenario: Manual cluster termination

- **WHEN** a user calls `DELETE /api/clusters/:clusterId`
- **THEN** the cluster transitions to `terminated`, leaves listings, and any session binding is released with a `cluster_terminated` broadcast
