## ADDED Requirements

### Requirement: The self-host funnel carries a verified acceptance case card

The funnel's full journey — self-hosted publish, official listing via the CLI bridge, 万星 catalog deploy with a bound deployer billing key, a real external-caller turn settled in real money, and the deployer share landing in the earnings ledger — SHALL be verified end to end against production at least once per roadmap phase, and the record SHALL live as a case card under docs/ecosystem/ with per-hop evidence (commands, responses, ledger rows), the identity topology (author/deployer/caller and why caller≠deployer holds), and honest boundaries (the share is the deployer earnings ledger per ADR-0022 — there is no separate author ledger; earnings offset consumption, no withdrawal in v1).

#### Scenario: A self-hoster can trust the funnel story

- **WHEN** a self-hoster reads the case card and repeats its hops
- **THEN** each documented command and response matches production behavior, because every hop was recorded from a real run, not composed

#### Scenario: Boundaries are stated, not implied

- **WHEN** the case card reaches the earnings hop
- **THEN** it states plainly that the share accrues to the deployer (the pack author earns by deploying their own pack, or not at all in v1) and that earnings offset consumption rather than withdrawing
