# agent-runner delta

## ADDED Requirements

### Requirement: A dead runner's agents are re-pointed to healthy runners

A control loop SHALL watch runner heartbeats and, when a runner's heartbeat is stale past the configured threshold, re-point its registry entries (url + runner assignment, port-collision-aware on the target slice) to the healthy runner with the most budget headroom. Entries of the fleet's default runner include its untagged entries. A re-pointed entry SHALL NOT move back when the old runner returns (hysteresis — the returned runner only receives new placements). When no healthy runner exists or no target has a free port slot, the loop SHALL take no action and log why.

#### Scenario: A stale runner's agent fails over

- **WHEN** a runner's heartbeat goes stale past the threshold and a healthy runner with headroom exists
- **THEN** the stale runner's entries carry the healthy runner's URL and assignment within the next loop pass, and the target hosts them on its next poll

#### Scenario: No healthy target means no action

- **WHEN** every runner is stale, or every healthy runner's port span is full
- **THEN** no entry is modified and the reason is logged

#### Scenario: A returned runner does not reclaim

- **WHEN** a failed-over runner's heartbeat resumes
- **THEN** previously moved entries stay where they are; only future placements may land on it
