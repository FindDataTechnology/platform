## MODIFIED Requirements

### Requirement: Steward device kind for cell lifecycle reporting

Paired devices SHALL include a `steward` kind: a desktop resident supervisor paired to the
platform for cell lifecycle reporting and desired-state pull (see `cell-lifecycle`). A
steward pairing SHALL use the same bind-code redemption, device public key registration,
and challenge login as any paired device. The redeemed device identity SHALL authorize
exactly two steward doors — the reporting door (posting `cell_presence`, `cell_manifest`,
and `cell_detail` events) and the desired-state read door (pulling ONLY its own machine's
deployment desired set, with merge-outcome write-back riding the reporting door) — and
SHALL NOT authorize user-session login, pack operations, reads of another machine's
desired set, or any control action into the device. Revoking the pairing SHALL cut both
doors immediately (next attempt answered `401`). The platform SHALL treat every
steward-originated payload as untrusted reporting data: whitelist fields only, no
content, no executable semantics. The platform SHALL NOT initiate any connection to a
steward-paired machine: both doors exist only as responses to machine-initiated requests.

#### Scenario: steward pairing redeems through the same doors

- **WHEN** a desktop steward redeems a bind code generated for lifecycle reporting
- **THEN** the device registers exactly like any paired device (public key on file,
  challenge login thereafter) and is marked kind `steward`

#### Scenario: steward credential authorizes only reporting

- **WHEN** a steward presents its device credential to a user-session endpoint, any
  mutating endpoint, or the desired-state endpoint of another machine
- **THEN** the request is rejected — the credential's authority is presence/manifest/detail
  reporting plus its own machine's desired-state read, nothing else

#### Scenario: revocation cuts reporting

- **WHEN** the steward's pairing is revoked from the console
- **THEN** its next reporting attempt AND its next desired-state pull are both answered
  `401`, and the steward-side contract is to self-destruct its pairing and go dark (see
  `cell-lifecycle` destroy protocol)

#### Scenario: pull is read-only and self-scoped

- **WHEN** a steward pulls its desired state
- **THEN** the response carries only its own machine's desired set with a version marker;
  no other machine's data is reachable through any steward-authorized endpoint
