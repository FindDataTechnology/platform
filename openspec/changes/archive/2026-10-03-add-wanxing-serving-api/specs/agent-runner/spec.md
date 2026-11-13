# agent-runner Specification (delta)

## ADDED Requirements

### Requirement: Facade-originated external contexts are idle-reaped

The runner SHALL reclaim runtime sessions under external contexts — the context namespace the facade derives for external callers — after a configurable idle period (default 24 hours), freeing session storage. Rhythm day-sessions and registry-path (internal) contexts SHALL NOT be subject to this reap. A message arriving on a reaped external context SHALL continue as a fresh conversation on that context — never an error, never a silently mixed history. Durable state across external requests belongs in the agent's own files, not session history.

#### Scenario: An idle external context is reaped silently

- **WHEN** an external context has been idle past the configured window and a message later arrives on it
- **THEN** the turn runs on a fresh session for that context, without error

#### Scenario: Internal and rhythm sessions are untouched

- **WHEN** the reap pass runs
- **THEN** rhythm day-sessions and internal (registry-path) contexts remain resident and unaffected
