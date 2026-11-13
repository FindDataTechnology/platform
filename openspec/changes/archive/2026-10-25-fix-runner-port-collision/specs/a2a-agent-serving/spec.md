# a2a-agent-serving Delta Spec

## ADDED Requirements

### Requirement: Port-occupancy listing degradation is visible

The deploy's port-occupancy map is built from a best-effort registry listing (the collision-avoidance contract). When that listing fails, the deploy SHALL still proceed with pure hash assignment (a registry hiccup must not refuse a deploy) but SHALL emit a named warning stating that collision detection is degraded — the silent form of this degradation let a hash collision reach the runner as a listener bind failure in production (2026-10-25, ledger §15.33).

#### Scenario: Registry listing failure warns instead of staying silent

- **WHEN** the occupancy listing fetch fails during a deploy
- **THEN** the deploy proceeds with hash-only port assignment and logs a warning naming the degradation and its consequence

#### Scenario: Healthy listing keeps the collision-avoidance contract

- **WHEN** the occupancy listing succeeds
- **THEN** a hash slot taken by another agent ring-probes the next free slot and stamps a port_override, exactly as before
