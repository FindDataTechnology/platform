# platform-billing Specification (Delta)

## ADDED Requirements

### Requirement: Ecosystem MCP consumption is metered with a monthly free grant

Calls through the registry gateway on a caller key to data and ecosystem servers SHALL be metered on the wire line as the single ledger — the facet and marketplace surfaces only relay, never record their own usage rows. Each caller key SHALL carry a monthly free grant of gateway calls (default 5,000 per calendar month, operator-configurable), resetting monthly. Beyond the grant, the preflight gate SHALL refuse admission with a quota error before any upstream touch, on the same fail-closed semantics as the existing preflight (billing disconnection refuses closed, never open). Metered consumption SHALL land in the sub2api account ledger so the grant, the overage refusal, and the account balance reconcile as one story; a ledger hard-stop SHALL bound runaway consumption when the ledger path is degraded.

#### Scenario: Free grant admits without charge

- **WHEN** a caller key's monthly call count is below the free grant
- **THEN** calls are admitted and the metered count is visible to the key's owner

#### Scenario: Grant exhaustion blocks upstream

- **WHEN** a caller key exhausts its monthly grant and another call arrives
- **THEN** the preflight gate refuses with a quota error and the upstream server is not touched

#### Scenario: One ledger, no parallel books

- **WHEN** metered ecosystem usage is inspected from any surface (ops board, key owner's usage view)
- **THEN** the numbers come from the wire-line ledger; no second usage tally exists at facet or marketplace

#### Scenario: Ledger degradation fails closed with a hard stop

- **WHEN** the ledger path is unavailable or degraded while calls keep arriving
- **THEN** the hard-stop bound refuses admission rather than letting unmetered calls through, and the refusal is visible to the operator
