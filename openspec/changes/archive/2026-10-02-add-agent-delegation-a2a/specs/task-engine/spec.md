# task-engine Delta

## MODIFIED Requirements

### Requirement: A task is the unit of work given to a persona
Every task SHALL carry a target (`{ type, ref }` — the executor), a prompt, and a dedicated session that receives its output, created no later than its first execution and visible in the normal session list with a title derived from the task. Every task SHALL carry exactly one trigger kind; a schedule trigger's firing semantics are defined by `cron-module`. Supported target types are `persona` (a persona of this cell) and, when the cell's catalog holds online a2a entries, `a2a` (a market Agent Service, executed as a remote task — openspec: agent-delegation-a2a; an a2a execution occupies no persona slot and switches no runtime). Creation SHALL reject a target whose `type` is not supported by the cell or whose `ref` the cell cannot resolve, and the persona type SHALL be supported.

#### Scenario: A scheduled task is a task with a schedule trigger

- **WHEN** a recurring job is created through the scheduling surface
- **THEN** the result is a task whose trigger is a schedule, target is the chosen persona, and whose executions land in the task's dedicated session

#### Scenario: Dedicated session appears in the session list

- **WHEN** a task is created
- **THEN** the system SHALL associate it with a session dedicated to that task, created no later than its first execution
- **AND** that session SHALL appear in the normal session list with a title derived from the task

#### Scenario: Unsupported target type is rejected

- **WHEN** a task is created with a target of an unsupported `type`
- **THEN** creation SHALL fail with a structured error and no task SHALL exist

#### Scenario: An a2a target is a first-class task

- **WHEN** a task is created with target `{type: "a2a", ref}` naming a catalog a2a entry
- **THEN** the task exists under the same model — dedicated session, history, lifecycle — and its executions run as remote turns that neither switch nor occupy the cell's runtime persona
