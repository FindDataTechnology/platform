# agent-runner delta

## ADDED Requirements

### Requirement: A runner hosts only the entries assigned to it

The runner SHALL host only registry entries assigned to it: an entry whose descriptor carries `runner_id` belongs to the runner with that id, and an entry without one belongs to the default runner. The default assignment SHALL come from configuration that defaults to the runner's own fleet id, so a legacy runner with no new configuration keeps hosting every unassigned entry and a new runner with a distinct fleet id hosts only entries explicitly assigned to it.

#### Scenario: A legacy runner keeps the unassigned fleet

- **WHEN** the registry holds entries without `runner_id` and a runner whose default id equals its own fleet id polls
- **THEN** it hosts those entries exactly as before the sharding change

#### Scenario: A sharded runner hosts only its own entries

- **WHEN** the registry holds entries tagged `runner_id=runner-b` alongside unassigned entries and runner-b polls
- **THEN** runner-b hosts only the runner-b entries and never duplicates the unassigned or other runners' agents
