# a2a-agent-serving delta

## ADDED Requirements

### Requirement: Deploys auto-place on the least-loaded healthy runner

When a deploy names no runner and the fleet table holds more than one runner, the deploy surface SHALL place the agent on the healthy runner with the most budget headroom (fewer children breaking ties), stamping the assignment explicitly. With a single fleet row, or when runner health is unreachable, the deploy SHALL keep the legacy behavior (untagged, default runner) rather than failing.

#### Scenario: An untagged deploy on a multi-runner fleet lands on the emptiest machine

- **WHEN** a deploy omits runnerId and the fleet holds several runners with differing load
- **THEN** the entry is stamped with the least-loaded healthy runner and its URL serves from that runner

#### Scenario: Health blindness degrades to the legacy default

- **WHEN** the health board is unreachable or the fleet holds one row
- **THEN** the deploy proceeds untagged exactly as before
