## Purpose

Provides a horizontal read-only aggregate bar above the fleet canvas showing fleet-wide configuration summary: model distribution across members, effort level spread, context budget histogram, and 24-hour edge traffic heatmap derived from existing cockpit aggregate. Enables the owner to answer 「整个舰队跑在什么上」at a glance without leaving the page.

## Requirements

### Requirement: Config bar presents model distribution

The config bar SHALL present a horizontal read-only aggregate above the canvas showing model distribution: each distinct effectiveModel in use across the fleet, with member count and percentage of total members. When all members share the same effectiveModel, a single consolidated pill SHALL indicate the fleet-wide model. Models SHALL render as human-readable names from the existing model roster.

#### Scenario: Mixed model fleet

- **WHEN** a 5-member fleet runs 2 members on model A, 2 on model B, and 1 on fleet default
- **THEN** the config bar presents three model pills with counts 2, 2, and 1, each labeled with the model name

#### Scenario: Single model fleet

- **WHEN** all members of a fleet share the same effectiveModel
- **THEN** the config bar presents a single consolidated pill indicating the fleet-wide model

### Requirement: Config bar presents effort level distribution

The config bar SHALL present the effort level distribution across fleet members: a proportional bar or histogram showing the count of members at each effort level (e.g., low, medium, high). The distribution SHALL be derived from each member's resolved effort level, consistent with the agent config dimensions.

#### Scenario: Effort histogram visible

- **WHEN** a fleet has 3 members at low effort, 2 at medium, and 1 at high
- **THEN** the config bar presents three segments proportional to 3:2:1, labeled with effort levels

### Requirement: Config bar presents context budget histogram

The config bar SHALL present a histogram of context budget usage across fleet members: each member's consumed context budget as a fraction of its declared maximum, grouped into buckets (e.g., 0-25%, 25-50%, 50-75%, 75-100%, over). Members without a declared budget SHALL be excluded from the histogram.

#### Scenario: Budget heatmap visible

- **WHEN** a 4-member fleet has context budgets at 20%, 45%, 80%, and 110%
- **THEN** the histogram presents four bars in buckets 0-25%, 25-50%, 50-75%, and over, with the 110% bar flagged as over-budget

### Requirement: Config bar presents 24h edge traffic heatmap

The config bar SHALL present a 24-hour edge traffic heatmap: for each declared orchestration edge, a color-coded indicator of recent turn traffic (OK/FAIL ratio) over the last 24 hours. Color temperature SHALL map green (all OK) through yellow (mixed) to red (all FAIL or no traffic). Edges with no traffic in the window SHALL be grayed out. The heatmap SHALL be derived from the existing turn result event stream, not a new data source.

#### Scenario: Edge traffic colors

- **WHEN** edge A had 5 OK and 0 FAIL in 24h, edge B had 2 OK and 3 FAIL, edge C had no traffic
- **THEN** the heatmap renders edge A green, edge B yellow/red, and edge C gray

#### Scenario: Mixed edge outcomes

- **WHEN** an edge had 3 OK and 2 FAIL turns in the last 24 hours
- **THEN** the heatmap renders that edge in a mixed color between green and red, proportional to the OK ratio

### Requirement: Config bar is pure read surface

The config bar SHALL be a pure read surface: it SHALL NOT trigger any write operation, SHALL NOT modify cockpit state, and SHALL NOT introduce new API endpoints. All data SHALL be derived from the existing /api/fleets/:id/cockpit aggregate response and real-time event channels.

#### Scenario: No write side effects

- **WHEN** a user views and interacts with the config bar (hover, click, filter)
- **THEN** no fleet configuration is modified, no new tasks are created, and no audit records are written
