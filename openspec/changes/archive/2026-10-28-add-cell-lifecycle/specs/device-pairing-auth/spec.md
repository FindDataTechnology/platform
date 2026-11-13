## ADDED Requirements

### Requirement: Steward device kind for cell lifecycle reporting

Paired devices SHALL include a `steward` kind: a desktop resident supervisor paired to the
platform for cell lifecycle reporting (see `cell-lifecycle`). A steward pairing SHALL use
the same bind-code redemption, device public key registration, and challenge login as any
paired device; the redeemed device identity SHALL authorize exactly one reporting door —
posting `cell_presence` and `cell_manifest` events — and SHALL NOT authorize user-session
login, pack operations, or any control action into the device. Revoking the pairing SHALL
cut the reporting door immediately (next attempt answered `401`). The platform SHALL treat
every steward-originated payload as untrusted reporting data: whitelist fields only, no
content, no executable semantics.

#### Scenario: steward pairing redeems through the same doors

- **WHEN** a desktop steward redeems a bind code generated for lifecycle reporting
- **THEN** the device registers exactly like any paired device (public key on file,
  challenge login thereafter) and is marked kind `steward`

#### Scenario: steward credential authorizes only reporting

- **WHEN** a steward presents its device credential to a user-session endpoint or any
  mutating endpoint outside the reporting door
- **THEN** the request is rejected — the credential's authority is presence/manifest
  reporting only

#### Scenario: revocation cuts reporting

- **WHEN** the steward's pairing is revoked from the console
- **THEN** its next reporting attempt is answered `401`, and the steward-side contract is
  to self-destruct its pairing and stop reporting (see `cell-lifecycle` destroy protocol)
