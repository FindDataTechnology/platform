## MODIFIED Requirements

### Requirement: An a2a target executes as a remote task

A delegated task whose target is `{type: "a2a", ref}` naming a catalog a2a entry SHALL execute as one A2A `message/stream` call to that agent's registry gateway route (`{registry}/agent/{path}/`, where `{registry}` is the registry gateway base URL resolved from the deployment's registry configuration — never a hard-coded example domain), sent with the cell caller credential on `X-Authorization`, the deployment's agent credential on `Authorization`, and a delegation depth header (below). The streamed reply text SHALL land in the task's dedicated session exactly like a persona execution's output, and the existing aggregation turn SHALL treat it as any finished task. An a2a-target execution SHALL NOT switch or occupy the cell's runtime persona.

#### Scenario: The reply lands as the task output

- **WHEN** a delegated a2a task's stream completes
- **THEN** its text is recorded in the task's dedicated session and the fan-out aggregation summarizes it like any other child task

#### Scenario: No persona switch for remote targets

- **WHEN** an a2a-target execution runs
- **THEN** the cell's interactive runtime keeps its persona and turn stream untouched

#### Scenario: Unknown a2a target is rejected at creation

- **WHEN** a delegate call names an a2a ref that is not in the cell's catalog
- **THEN** the task is not created and the tool returns a structured error naming the unknown target
