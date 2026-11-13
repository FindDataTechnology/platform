# device-pairing-auth Delta

## Purpose

Native app (universal client) login for 壹座: a device pairs once by redeeming a web-session bind code against an Ed25519 public key, then signs single-use challenges to receive account-identity platform tokens — the only identity path that holds for all three AUTH_MODE shapes (`none` / `forward_auth` / `logto`), because its trust anchor is the instance's own web session, not an identity provider.

## ADDED Requirements

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

An authenticated web session SHALL list the devices paired to its own account (`GET /api/app/devices`) — each with device label and bound-at time, and without exposing stored public keys — and SHALL revoke any of them (`DELETE /api/app/bind/:deviceId`). Revocation SHALL remove the binding persistently; the revoked device's next silent exchange SHALL fail as unbound. A request from a different account SHALL NOT list or revoke another account's devices.

#### Scenario: devices list shows paired devices

- **WHEN** the user opens the Settings paired-devices section on the web
- **THEN** every device paired to the account appears with its label and bound-at time

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
