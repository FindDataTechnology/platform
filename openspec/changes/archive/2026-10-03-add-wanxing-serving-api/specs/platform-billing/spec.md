# platform-billing Specification (delta)

## ADDED Requirements

### Requirement: External turns settle against the caller's key at the boundary

Facade-admitted external turns SHALL be charged to the caller's own sub2api key by duration — rounded up to whole minutes at the platform-configured rate — settled as an idempotent admin balance deduction on turn completion. The serving agent's actual model consumption SHALL continue on the deployer's bound key; the settlement amount is a function of duration and rate, independent of token usage. Until sub2api gains a native usage-recording endpoint, the facade ledger is the authoritative usage record for external turns; calls on the internal registry path (web chat, delegation) remain deployer-paid and produce no caller settlement — the dual-track model of ADR-0014.

#### Scenario: An external turn charges the caller by duration

- **WHEN** a facade-admitted turn of 90 seconds completes at a configured per-minute rate
- **THEN** the caller's balance is deducted for 2 minute-units at that rate, while the deployer-side key flow for the agent is unchanged

#### Scenario: Internal calls stay deployer-paid

- **WHEN** the same agent serves an internal registry-path call (web chat or delegation)
- **THEN** no caller settlement occurs and no caller ledger entry is written

#### Scenario: One turn, one deduction

- **WHEN** the settlement attempt is retried after a transient sub2api failure
- **THEN** the balance deduction lands exactly once, guarded by an idempotency key

#### Scenario: The ops board shows both dimensions

- **WHEN** an operator opens the billing board
- **THEN** external usage is viewable by caller and by agent alongside the existing deployer-side view
