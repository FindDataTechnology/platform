# marketplace-cluster-view Specification

## Purpose

Makes cluster packs discoverable in the pack marketplace: an agent-count filter on the listing and a cluster section on the detail view. The subscribe/install flow is unchanged — a cluster pack installs like any pack, and its members then appear grouped in the chat agent picker (openspec: agent-cluster-core).

## Requirements

### Requirement: Marketplace listing filters by agent count

The marketplace listing SHALL offer an agent-count filter with the buckets 1, 2-3, and 4+ agents, applied on the summaries' `agentCount` (computed server-side from the latest version's manifest). The selected bucket SHALL live in the `agents` URL query parameter so a refresh keeps it. Summaries without an `agentCount` (an older server) SHALL pass through unfiltered rather than disappear.

#### Scenario: Agent-count filter applied

- **WHEN** a user selects the 2-3 bucket
- **THEN** only packs whose latest version declares two or three agents are listed

#### Scenario: Filter state in URL

- **WHEN** a user applies the filter and refreshes the page
- **THEN** the same bucket is re-applied from `?agents=`

### Requirement: Pack detail shows cluster composition

When a pack's manifest declares `cluster`, its detail view SHALL render a cluster section with the cluster name, description, and agent count, listing the default members and offering a toggle that reveals the optional members. Packs without cluster metadata SHALL render exactly as before.

#### Scenario: Cluster section on pack detail

- **WHEN** a user opens the detail view of a pack with cluster metadata
- **THEN** the view shows the cluster name, description, member count, and the default members

#### Scenario: Optional members toggle

- **WHEN** a user clicks the optional-members toggle
- **THEN** the optional members are revealed with their names
