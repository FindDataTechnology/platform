# agent-runner delta

## ADDED Requirements

### Requirement: The runner honors a valid port override from the descriptor

The runner SHALL derive each hosted agent's listen port with the same shared definition the deploy side uses: a descriptor `port_override` that is an integer inside the runner's own span wins; anything absent, non-integer, or out of range falls back to the path hash. Health reporting SHALL show the same resolved port the listener binds.

#### Scenario: A valid override binds the stamped port

- **WHEN** an entry's descriptor carries `port_override` within the runner's span
- **THEN** the listener binds that port and health reports it

#### Scenario: Junk overrides fall back to the hash

- **WHEN** the override is non-numeric or outside the span
- **THEN** the listener binds the hash port exactly as before
