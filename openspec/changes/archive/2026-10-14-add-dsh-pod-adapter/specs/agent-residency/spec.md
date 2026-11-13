# agent-residency 变更（add-dsh-pod-adapter）

## MODIFIED Requirements

### Requirement: The warm zone demotes under budget and re-warms in seconds

The runner SHALL enforce a per-host memory budget for resident children (a configurable cost per agent, calibrated from the measured resident footprint, against a configurable host budget). When the budget would be exceeded, the runner SHALL demote the idle-most resident child into the warm zone — the process is reaped while its state stays on disk — and the demotion SHALL be visible in health. In pod mode (add-dsh-pod-adapter) the accounting unit is the pod: a resident pod counts its sampled RSS once against the budget (falling back to the configurable per-pod cost floor), never once per member; demoting a pod demotes every member to warm together, and any member's next touch re-warms the pod with all members composed from disk state. A warm child (or pod) SHALL re-warm on its next touch in seconds, with its context intact; demotion SHALL NEVER discard state or lose sessions. Promotion back to resident happens on touch, and the runner SHALL hysteresis against thrash (no automatic promote/demote cycles under a boundary-hovering load).

#### Scenario: Over-budget demotes the idle-most resident

- **WHEN** starting or keeping a resident child would exceed the host memory budget
- **THEN** the idle-most resident child is demoted to the warm zone, its state remains on disk, and health reports it as warm

#### Scenario: A warm child re-warms with context intact

- **WHEN** a message arrives for a warm-zone child
- **THEN** it re-warms within seconds and answers with its prior context intact — no cold, stateless restart

#### Scenario: No thrash at the boundary

- **WHEN** load hovers at the budget boundary
- **THEN** the runner does not repeatedly demote and re-promote the same child

#### Scenario: A pod counts once and demotes whole

- **WHEN** a pod hosting three members is the idle-most resident at a budget breach
- **THEN** the budget charged the pod's RSS (or per-pod floor) once — not three agent costs — the pod's process is demoted with all three members reporting warm, and any member's next message re-warms the pod serving all members
