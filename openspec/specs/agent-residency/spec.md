# agent-residency Specification

## Purpose

The resident lifecycle domain for deployed Agent Services: agents stay resident with cross-day continuous context, act autonomously only through platform-injected self-turns driven by a declared work rhythm, overflow into a warm zone under host memory budgets, and pause reversibly (ADR-0010).

## Requirements

### Requirement: Resident agents are not idle-reaped

A deployed Agent Service's runtime child SHALL remain resident by default: the runner SHALL NOT reap it after any idle interval, and its next message SHALL be served without a cold start. Idle reaping survives only as the warm-zone demotion mechanism under the host memory budget (below); it is never a timer on its own.

#### Scenario: An idle resident stays warm

- **WHEN** a resident child has been idle longer than any configured interval and a message arrives
- **THEN** the message is served by the warm child with no cold start

### Requirement: The warm zone demotes under budget and re-warms in seconds

The runner SHALL enforce a per-host memory budget for resident children (a configurable cost per agent, calibrated from the measured resident footprint, against a configurable host budget). When the budget would be exceeded, the runner SHALL demote the idle-most resident child into the warm zone — the process is reaped while its state stays on disk — and the demotion SHALL be visible in health. A warm child SHALL re-warm on its next touch in seconds, with its context intact; demotion SHALL NEVER discard state or lose sessions. Promotion back to resident happens on touch, and the runner SHALL hysteresis against thrash (no automatic promote/demote cycles under a boundary-hovering load).

#### Scenario: Over-budget demotes the idle-most resident

- **WHEN** starting or keeping a resident child would exceed the host memory budget
- **THEN** the idle-most resident child is demoted to the warm zone, its state remains on disk, and health reports it as warm

#### Scenario: A warm child re-warms with context intact

- **WHEN** a message arrives for a warm-zone child
- **THEN** it re-warms within seconds and answers with its prior context intact — no cold, stateless restart

#### Scenario: No thrash at the boundary

- **WHEN** load hovers at the budget boundary
- **THEN** the runner does not repeatedly demote and re-promote the same child

### Requirement: Context rolls daily with a carry-over digest

For each resident agent the runner SHALL roll the active session at a configured day boundary: the outgoing session is archived, a fresh session opens, and a 「昨日纪要」 digest of the outgoing session is injected at the head of the new session. The digest SHALL be produced by a platform-injected self-turn of the agent itself at rollover (metered like any turn). Daily digests and session archives SHALL be pushed to a configurable archive target; the loss window on host death SHALL be at most one day.

#### Scenario: Day rollover carries the digest

- **WHEN** an agent's active session crosses the configured day boundary
- **THEN** the outgoing session is archived, the new session opens with the digest of the previous day injected at its head

#### Scenario: Archives land on the configured target

- **WHEN** a rollover completes
- **THEN** the digest and the session archive are pushed to the configured archive target, and a host failure loses at most the current day

### Requirement: The effective rhythm schedules self-turns

Each agent has an effective work rhythm — the deployment descriptor's override when present, else the manifest's declared default; no rhythm means the agent only answers and never acts on its own. The runner's scheduler SHALL fire self-turns at the rhythm's due times: every self-turn is a platform-injected turn queued through the same bounded queue as messages, observable as a turn whose initiator is the agent itself, and carrying token metering. A missed due time (runner restart, pause, warm zone) SHALL be skipped, never caught up in a burst.

#### Scenario: A due rhythm fires a self-turn

- **WHEN** the effective rhythm's due time arrives for a resident agent
- **THEN** a self-turn is enqueued through the shared queue and its execution is observable and metered

#### Scenario: No rhythm means no self-turns

- **WHEN** an agent has no effective rhythm
- **THEN** the scheduler never injects any turn for it

#### Scenario: The deployer override wins

- **WHEN** the descriptor carries a rhythm override differing from the manifest default
- **THEN** the override is effective and the manifest default is ignored

#### Scenario: Missed dues are skipped

- **WHEN** a due time passes while the agent is paused or in the warm zone
- **THEN** that occurrence is skipped and no catch-up burst runs on resume

### Requirement: Pause is reversible and explicit to callers

Pausing an agent SHALL demote it to the warm zone, stop all injections (self-turns and message serving), mark its registry entry paused, and bring its consumption to zero. A caller reaching a paused agent SHALL receive an explicit paused error, never a timeout or a cold start. Resuming SHALL restore serving with context intact in one action. The platform's emergency stop SHALL be the same mechanism triggered by the platform rather than the deployer.

#### Scenario: Paused callers get an explicit error

- **WHEN** an A2A call arrives for a paused agent
- **THEN** the caller receives an explicit paused response, not a timeout

#### Scenario: Resume restores serving

- **WHEN** a paused agent is resumed
- **THEN** it re-warms on the next event with context intact and its rhythm resumes from the next due time

#### Scenario: The emergency stop reuses pause

- **WHEN** the platform triggers the emergency stop on an agent
- **THEN** the agent enters the same paused state a deployer pause produces, and the same resume path applies
