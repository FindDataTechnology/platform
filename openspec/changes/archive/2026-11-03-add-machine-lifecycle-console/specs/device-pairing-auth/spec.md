## MODIFIED Requirements

### Requirement: Device bindings are visible and revocable from the paired account's web session

An authenticated web session SHALL list the devices paired to its own account (`GET /api/app/devices`) — each with device label, bound-at time and device kind, and without exposing stored public keys — and SHALL revoke any of them (`DELETE /api/app/bind/:deviceId`). The account's device-management faces SHALL be split by kind: app-kind devices SHALL remain listed and revocable in the Settings paired-devices section, while steward-kind machines SHALL be listed and revocable from the machine console (`/machines`), which is the steward lifecycle surface. Revocation SHALL remove the binding persistently; the revoked device's next silent exchange SHALL fail as unbound. Steward revocation SHALL additionally clear that machine's cloud-side desired set so a re-pairing under the same device identifier does not inherit stale expectations. A request from a different account SHALL NOT list or revoke another account's devices.

#### Scenario: devices list shows paired devices

- **WHEN** the user opens the Settings paired-devices section on the web
- **THEN** every app-kind device paired to the account appears with its label and bound-at time; steward-kind machines appear in the machine console instead, and the Settings section does not present them as app devices

#### Scenario: steward machines are managed from the machine console

- **WHEN** the user opens the machine console while holding steward-kind pairings
- **THEN** each steward machine appears in the roster with its label and bound-at time, and its detail surface offers revocation there

#### Scenario: revocation kills silent login

- **WHEN** the user revokes a paired device on the web and that device next attempts its silent launch
- **THEN** the exchange responds `401` and the device must pair again with a fresh bind code

#### Scenario: one account cannot manage another's devices

- **WHEN** an authenticated request attempts to list or revoke devices of a different account
- **THEN** the endpoint does not act on the other account's bindings
