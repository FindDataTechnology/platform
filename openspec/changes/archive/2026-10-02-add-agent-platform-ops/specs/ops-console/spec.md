# ops-console Delta

## ADDED Requirements

### Requirement: The board shows the agent fleet

The console SHALL render an agent-fleet section fed by the runner's health surface and the platform's billing reads: every deployed agent with its live state (resident / warm / starting / serving / paused / draining), its host runner, its billing key's consumption (spend to date from the runner's metered turns plus the gateway's usage read), and the deployer's balance. A runner or billing read that fails SHALL render that row's values as failed with age, not omit the row. The section SHALL also show the platform's upstream account-pool isolation as a single health line (isolated pool configured and serving, or shared-pool warning).

#### Scenario: The fleet lists live states

- **WHEN** the console polls with three deployed agents (one serving, one warm, one paused)
- **THEN** the section lists all three with their distinct states and consumption

#### Scenario: A failed read degrades visibly

- **WHEN** the runner health poll fails while billing reads succeed
- **THEN** the agents render with their last-known states marked stale, and the consumption columns still show current reads
