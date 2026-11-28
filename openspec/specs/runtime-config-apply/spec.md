# runtime-config-apply Specification

## Purpose
The single, observable policy by which a configuration mutation reaches an already-running agent runtime. It exists because the decision "apply this live, park it for the next session, or restart the process" was being re-derived in two places (the platform cell bridge and the runner harness) with different answers, and a restart — a 1.2–6 s respawn that drops in-memory session state — was happening where a live surface already existed. This capability owns the decision, the fallback ladder, and the evidence that a chosen surface actually carried the change.

## Requirements

### Requirement: Every config mutation names the surface that applies it

Applying a configuration change to a running agent runtime SHALL route it through a declared application surface and SHALL record, observably, which surface it used or, on restart, why no surface could carry the change. A configuration-caused restart SHALL be distinguishable from a crash restart. Restarting to apply a config change without recording the reason SHALL count as a defect.

#### Scenario: live surface is used and named
- **WHEN** a config change is applied and the runtime declares a surface that can carry it
- **THEN** the change SHALL be applied through that surface and the used surface SHALL be recorded on the observability surface
- **AND** no restart SHALL be triggered

#### Scenario: restart is the fallback and says why
- **WHEN** no declared surface can carry the change
- **THEN** the runtime MAY be restarted, and the restart record SHALL name the configuration reason
- **AND** the restart SHALL be distinguishable from a crash restart in the same record

### Requirement: A fixed preference ladder decides the surface

The system SHALL choose the application surface by a fixed ladder: (1) a live control method on the running runtime when declared, (2) creation-time parking for a change composed only at session creation, applied to the next blank session, (3) a restart. A workspace/cwd change SHALL be restart-only because no per-session working directory exists. The ladder SHALL evaluate identically for the same change on cell and runner.

#### Scenario: live method wins over restart
- **WHEN** a change has both a declared live method and a restart path
- **THEN** the live method SHALL be chosen and no restart SHALL occur

#### Scenario: creation-time-only change parks, not restarts
- **WHEN** a change can only be composed at session creation and the runtime declares the parking method
- **THEN** the change SHALL be parked for the next blank session rather than restarting the running runtime

#### Scenario: workspace change restarts
- **WHEN** the working directory changes
- **THEN** the runtime SHALL restart (no per-session cwd exists) and the restart reason SHALL name the workspace change

### Requirement: Persona/preset parks only where the runtime composes the full face per session

A persona/preset selection SHALL park for the next blank session only when the runtime declares it can compose that persona's complete face — tool face and skill face — at session creation. When it cannot (e.g. a host whose skills face is one process-level patch), the selection SHALL restart and name the persona dimension. Guards are unchanged: reject while streaming, reject unknown/broken ids, persist, and never recompose a session with turns.

#### Scenario: runtime that composes the full face parks without restart
- **WHEN** the runtime declares it can compose a persona's tool and skill faces per session, and the user selects a different persona
- **THEN** the selection SHALL be parked for the next blank session, `current_preset` SHALL be broadcast, and no child restart SHALL occur
- **AND** a session that already has turns SHALL keep its composition

#### Scenario: runtime with a process-level skill face restarts, named
- **WHEN** the runtime cannot compose the persona's skill face per session (its skills are a single process-level patch)
- **THEN** the selection SHALL be applied by restarting, and the restart record SHALL name the persona dimension
- **AND** no session SHALL be composed with another persona's skills

### Requirement: MCP server-set changes are applied live; credential-value changes restart, named

A change to the composed MCP server set (add, remove, enable, disable) SHALL apply through the runtime's live patch hot-swap when the runtime supports it, without restarting. A change to a server's credential **value** (an Authorization header) SHALL restart, because patch hot-swap does not deliver header-value changes, and the restart SHALL name the credential change. When hot-swap is unavailable the set change SHALL restart and name the MCP composition change.

#### Scenario: server-set change hot-swaps
- **WHEN** an MCP server is added, removed, enabled, or disabled and the runtime hot-swaps its patch
- **THEN** the change SHALL apply without restarting and the used surface SHALL be recorded

#### Scenario: credential-value change restarts, named
- **WHEN** a server's credential value changes
- **THEN** the runtime SHALL restart and the record SHALL name the credential change

#### Scenario: no hot-swap surface
- **WHEN** the runtime cannot hot-swap the MCP patch
- **THEN** a set change SHALL restart and the record SHALL name the MCP composition change

### Requirement: Cell and runner apply config through one decision contract

The platform cell bridge and the runner harness SHALL evaluate the same ladder over the same surface set and emit the same reason vocabulary for a given config change. Only host policy state — busy detection, turn claims, deferred delivery — differs. The same change against runtimes with the same capabilities SHALL record the same outcome on both hosts.

#### Scenario: same change, same decision on both hosts
- **WHEN** the same config change is applied against runtimes declaring the same capabilities on the cell and on the runner
- **THEN** both SHALL choose the same surface and record the same reason

#### Scenario: differing capability yields differing, still-legal decision
- **WHEN** the cell's runtime declares a live method the runner's does not (or vice versa)
- **THEN** each host SHALL follow the ladder against its own runtime's declaration, recording its own reason, without assuming the other host's capability
