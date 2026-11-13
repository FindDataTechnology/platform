# agent-runner Delta Spec

## ADDED Requirements

### Requirement: A listener bind failure isolates to its own agent

When a per-agent A2A listener fails to bind its port (address in use or any other listen error), the runner SHALL keep serving every other hosted agent: the failing listener SHALL be released, the failure SHALL be logged as a named warning (agent key, port, and the port_override remediation hint), and the process SHALL NOT crash. The runner MAY retry the bind on later reconcile cycles; repeated warnings for the same agent SHALL be rate-limited so a persistently occupied port cannot flood the log. A skipped listener SHALL leave the agent's reachability honestly degraded (its registered port answers nothing) rather than silently mis-routed.

#### Scenario: A hash collision with an existing listener does not crash the runner

- **WHEN** a newly reconciled agent resolves to a port another agent's listener already holds
- **THEN** the runner logs a named warning for the new agent, continues serving the existing listener and all other agents, and the process stays up

#### Scenario: The skipped agent retries and recovers after the port frees

- **WHEN** the occupied port is later freed (the occupant undeployed or moved) and a reconcile cycle re-runs
- **THEN** the runner binds the skipped agent's listener without a restart

#### Scenario: Persistent bind failure does not flood the log

- **WHEN** the same agent fails to bind on every reconcile cycle
- **THEN** the named warning is rate-limited per agent rather than emitted on every cycle
