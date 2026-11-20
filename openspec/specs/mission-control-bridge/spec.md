## Purpose

The cell-side Mission Control integration: an opt-in bridge that enrolls a cell as ONE controlled unit in a self-hosted MC console, runs console-dispatched tasks through the cell's task engine, and reports outcomes back — without granting the console any inbound reach into the cell.

## Requirements

### Requirement: The bridge is off by default and opt-in per cell
The MC bridge SHALL be inert unless enabled by environment (`MC_BRIDGE=1` with `MC_URL` and `MC_API_KEY`). When inert, the cell SHALL make no MC-related outbound traffic and behave exactly as before this capability. Deployment enrollment is limited to the operator's own and demo cells; user cells do not enroll.

#### Scenario: Off means off
- **WHEN** a cell boots without the bridge environment
- **THEN** no registration, heartbeat, or queue poll occurs, and all other capabilities are unchanged

### Requirement: The cell registers as one console agent and stays reachable only outbound
The bridge SHALL register the cell as a single MC agent named for the deployment, send heartbeats, and poll that agent's task queue — all outbound requests to the configured console URL. The console's "agent" maps to the cell as a whole, never to a persona; no inbound port or credential is exposed to the console.

#### Scenario: Registration and heartbeat
- **WHEN** the bridge starts with valid console credentials
- **THEN** the cell appears as one agent in the console and heartbeats continue while the cell runs

#### Scenario: Agent is the cell
- **WHEN** a persona-pinned task is dispatched to the cell's agent
- **THEN** the bridge executes it under the named persona on the cell's runtime — the console never sees per-persona agents

### Requirement: A claimed console task maps to an engine manual task idempotently
Each claimed console task SHALL carry a target persona and prompt, and SHALL create exactly one manual-trigger engine task (dedicated session, immediate dispatch under the cell's slot policy). The console task id SHALL be persisted on the cell task; a re-seen console task id SHALL NOT create a second cell task. A console task naming an unknown persona SHALL be reported failed to the console with a structured error and SHALL create no cell task.

#### Scenario: Claim runs as a manual task
- **WHEN** the bridge claims a console task for persona P with a prompt
- **THEN** a manual-trigger task targeting P executes on the cell and appears in /tasks with its dedicated session

#### Scenario: Restart mid-claim does not double-create
- **WHEN** the cell restarts after creating the cell task but before posting its result, and the console task is still queued or pending
- **THEN** the bridge reuses the existing cell task instead of creating another

#### Scenario: Unknown persona fails the console task
- **WHEN** a claimed console task names a persona the cell does not have
- **THEN** the console task is reported failed with a structured error naming the persona
- **AND** no cell task is created

### Requirement: Outcomes are posted back per execution
When a bridge-created task's execution reaches a terminal state, the bridge SHALL post the state, output text, error gist, and token spend (when reported) back to the console task. Posting failures retry with backoff and SHALL NOT affect the cell task's state.

#### Scenario: Done round trip
- **WHEN** a console-dispatched task finishes successfully
- **THEN** the console task carries the output and terminal state

#### Scenario: Failure round trip
- **WHEN** a console-dispatched task fails or is interrupted
- **THEN** the console task carries the failure state and the error gist

### Requirement: Console outages never affect the cell
When the console is unreachable or returns errors, the bridge SHALL back off its polling and retries with escalating intervals, log the condition, and continue operating every other cell capability normally. The bridge SHALL NOT block cell boot, chat, delegation, scheduling, or worker execution.

#### Scenario: Console down, cell fine
- **WHEN** the console URL is unreachable for an extended period
- **THEN** the cell's chat and task capabilities continue to work and the bridge keeps retrying with backoff
