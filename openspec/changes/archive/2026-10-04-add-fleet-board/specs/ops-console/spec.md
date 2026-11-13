# ops-console Specification Delta

## ADDED Requirements

### Requirement: The fleet overview reads the Wanxing observation API

The console SHALL poll the Wanxing fleet observer's board endpoint (`FLEET_BOARD_URL` with the `FLEET_BOARD_TOKEN` service credential) as a `fleetBoard` source and render a fleet overview section ahead of the per-agent table: agent total, five-state distribution, per-runner residency stats (children, memory budget vs limit, queued), wake latency p50/p95, 24h turns/errors/budget-kills/reaped, pending settlements, and per-source ingestion lag (event-age and arrival bases). The section SHALL follow the console's degradation discipline: unconfigured renders an explicit not-configured note, a failed read renders stale/failed with age — never a silently omitted section. The existing per-agent runner-health table remains as the detail view during the transition.

#### Scenario: fleet overview renders from the observer

- **WHEN** FLEET_BOARD_URL is configured and the observer answers
- **THEN** the overview section shows the full first-version metric set, ahead of the per-agent table

#### Scenario: observer unavailable degrades visibly

- **WHEN** the observer is unreachable or unconfigured
- **THEN** the overview section renders a failed/not-configured state with the last data's age, and the rest of the board is unaffected
