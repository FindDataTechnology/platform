# device-pairing-auth Specification

## Purpose

Native app (universal client) login for 壹座: a device pairs once by redeeming a web-session bind code against an Ed25519 public key, then signs single-use challenges to receive account-identity platform tokens — the only identity path that holds for all three AUTH_MODE shapes (`none` / `forward_auth` / `logto`), because its trust anchor is the instance's own web session, not an identity provider.

## Requirements

### Requirement: First pairing redeems a bind code and registers a device public key

An authenticated WEB session SHALL mint a single-use 6-digit bind code (short-lived, bound to the signed-in account — the same minting mechanism and lifecycle as the mini-program bind code) with two presentation forms: the numeric code for manual entry, and a QR encoding `<web-origin>/settings/devices?bindcode=<code>` so a scanning app obtains the instance address and the code in one capture. A native app's first sign-in SHALL redeem that code at `POST /api/app/pair` together with a client-chosen opaque device identifier, an Ed25519 public key, and a device label; the server — the gateway or a single-process deployment — SHALL then bind the device to the account (persisted server-side, surviving restarts, in that deployment's own data store, namespaced apart from mini-program openid bindings) and issue a platform token carrying the ACCOUNT identity (email + groups) plus a device-pairing kind marker and the device identifier. A wrong, expired, or already-redeemed code SHALL be rejected with `401` and SHALL NOT create a binding; a malformed request SHALL be rejected with `400`.

#### Scenario: successful first pairing

- **WHEN** the app redeems a valid bind code from the user's signed-in web session — by scanning the Settings QR or by typing the digits — together with its device identifier and Ed25519 public key
- **THEN** the server binds the device to that account and returns a platform token whose identity is the account's email and groups, carrying the device-pairing kind marker and the device identifier

#### Scenario: the pairing QR carries the instance address

- **WHEN** the app scans the QR shown in the web Settings paired-devices section
- **THEN** the captured payload resolves to both the instance's web origin and the 6-digit code, and no address is typed

#### Scenario: wrong, expired, or reused code leaves nothing behind

- **WHEN** the app redeems an incorrect, expired, or already-redeemed bind code
- **THEN** the endpoint responds `401` and the device remains unbound

#### Scenario: binding survives a restart

- **WHEN** a device was paired and the deployment restarts
- **THEN** the binding is still resolvable and the next silent launch succeeds without a new bind code

### Requirement: Paired devices log in silently through a single-use challenge

For a paired device, every launch SHALL be silent: the client requests a challenge for its device identifier (`POST /api/app/challenge`), receives a single-use short-lived nonce, and presents a signature of that nonce made with the device private key (`POST /api/app/login`); the server SHALL verify the signature against the bound public key and issue a fresh platform token carrying the bound account identity — no UI, no interaction. A replayed or expired nonce, an unknown device identifier, or a signature that fails verification SHALL each be rejected with `401`; challenge issuance SHALL be bounded against unauthenticated abuse. A device whose binding has been revoked SHALL receive `401` with a re-pairing semantic (indistinguishable from never-bound). An expired token on the client SHALL be recovered by re-running the silent challenge exchange, and only a revoked binding leads back to the pairing screen.

#### Scenario: silent launch

- **WHEN** a paired app starts and requests a challenge
- **THEN** it receives a single-use nonce, its signature over the nonce verifies against the bound public key, and it receives a fresh platform token with no user interaction

#### Scenario: replayed nonce is rejected

- **WHEN** the same nonce is submitted twice to the login exchange
- **THEN** the second submission responds `401` and no token is issued

#### Scenario: revoked device is told to re-pair

- **WHEN** an app whose binding was revoked requests a challenge or attempts the login exchange
- **THEN** the endpoint responds `401` and the client returns to the pairing flow

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

### Requirement: The config endpoint advertises device-pairing capability

`GET /api/config` — reachable without authentication — SHALL include a `capabilities` object that reports `devicePairing: true` when this identity path is available on the deployment. Deployments without the path MAY omit the field entirely; clients SHALL treat an absent field as unsupported and degrade without blocking connection.

#### Scenario: capability advertised

- **WHEN** a client fetches `/api/config` from a deployment with device pairing available
- **THEN** the response includes `capabilities.devicePairing: true`

#### Scenario: absent capability means unsupported

- **WHEN** a client fetches `/api/config` from an older deployment whose response has no `capabilities` object
- **THEN** the client treats device pairing as unavailable and does not attempt the pairing flow

### Requirement: Pairing doors also open on the facet service

The facet service SHALL mount the same device-pairing surface — bind-code minting from a facet-domain session, first pairing, silent challenge login, and the paired-device management face — backed by its own bindings store under its data root, reusing the shared pairing modules verbatim. Pairing SHALL be inert with an honest 503 while the shared token secret is unset, without affecting the rest of the facet surface. The facet identity resolution SHALL accept a verified app token (`kind: "app"`) as an account-identity channel, composing it after the proxy and session channels, exactly as the 壹座 gateway does.

#### Scenario: CLI pairs against the facet domain

- **WHEN** a device pairs on the facet domain with a bind code minted from a facet-domain session
- **THEN** pairing succeeds against the facet bindings store, and the issued token authenticates the publish route on that same domain under the bind code's account identity

#### Scenario: Silent login on the facet domain

- **WHEN** an already-paired device silently logs in on the facet domain
- **THEN** the single-use challenge is answered with a fresh account-identity token; no browser session is involved

#### Scenario: Facet without the token secret is honestly closed

- **WHEN** the facet service runs without the shared token secret configured
- **THEN** the pairing doors answer 503 and the remainder of the facet surface (browse, detail, web publish) is unaffected

#### Scenario: Devices are revocable via the facet domain

- **WHEN** a paired account revokes one of its devices through the facet domain, presenting either a web session or an app token
- **THEN** the revocation lands in the facet bindings store and the device's next silent login is refused with binding_required

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
