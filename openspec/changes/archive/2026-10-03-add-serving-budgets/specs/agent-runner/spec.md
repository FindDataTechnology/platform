# agent-runner Specification (delta)

## ADDED Requirements

### Requirement: Turn budgets are enforced with a hard stop

The runner SHALL run every turn of a deployed role — messages, rhythm self-turns, and rollover digests alike — under that role's effective turn budget: the deployment descriptor's budget when present, else the runner's configurable deployment default. When a turn exceeds its budget, the runner SHALL stop the turn by a hard stop: the child process is stopped and re-spawns on the role's next touch (dsh has no interrupt RPC — ADR-0014 ④; the private home's file state and durable agent state survive), the caller receives a structured error naming the budget bound, and the meter records the turn as a budget kill. A role whose descriptor carries no budget SHALL behave exactly as before this change under the deployment default.

#### Scenario: An over-budget turn is hard-stopped with a named bound

- **WHEN** a role with an effective budget of N minutes runs a turn that exceeds it
- **THEN** the turn fails with a structured error naming the N-minute bound, the child process is stopped, and the next message on that role cold-starts a fresh child

#### Scenario: Durable state survives the stop

- **WHEN** a budget kill stops a child mid-turn
- **THEN** the role's private home, session storage, and any files the agent wrote remain on disk, and the next conversation continues from them

#### Scenario: Every turn source shares the budget

- **WHEN** a rhythm self-turn or rollover digest exceeds the role's effective budget
- **THEN** it is stopped under the same discipline as a message turn, and the meter records the kill

#### Scenario: No budget means the deployment default

- **WHEN** a deployed role's descriptor carries no budget field
- **THEN** its turns run under the runner's configurable deployment default, unchanged in behavior from before this change
