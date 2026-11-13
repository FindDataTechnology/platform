## Purpose

WeChat login for mini-program clients, built on ACCOUNT BINDING to the
platform identity provider (Logto): the first launch on a device signs in
once with the platform account (username/phone + password), the gateway
binds the WeChat openid to that account, and every later launch is a silent
wx.login exchange. Tokens carry the ACCOUNT identity — the same
email/groups as the web session — so a user shares one cell and one dataset
across the mini program and the browser. Browsers keep using the existing
Logto redirect flow; this capability adds a second, mini-program-only door.

## ADDED Requirements

### Requirement: First sign-in redeems a bind code minted from the web session

The platform identity provider (Logto) offers no password grant (deprecated
in OAuth 2.1), so credentials never enter the mini program. Instead, an
authenticated WEB session SHALL mint a single-use 6-digit bind code
(`GET /api/mp/bindcode`, 5-minute validity, bound to the signed-in account).
The mini program's login page SHALL redeem that code together with a fresh
`wx.login` code at `POST /api/mp/login-bindcode`; the server SHALL then bind
the WeChat openid to the account (persisted server-side, surviving restarts)
and issue a platform token carrying the ACCOUNT identity (email + groups). A
wrong, expired, or already-redeemed code SHALL be rejected with `401` and
SHALL NOT create a binding; a malformed code SHALL be rejected with `400`.

#### Scenario: successful first sign-in

- **WHEN** the user enters a valid bind code from their signed-in web session
- **THEN** the server binds the openid to that account and returns a platform token whose identity is the account's email and groups

#### Scenario: wrong, expired, or reused code leaves nothing behind

- **WHEN** the user enters an incorrect, expired, or already-redeemed bind code
- **THEN** the endpoint responds `401` and the openid remains unbound

### Requirement: Bound openids log in silently; unbound ones are asked to sign in

For a client whose openid is bound, the silent path SHALL exchange a fresh
`wx.login` code (`POST /api/mp/login`) for a platform token carrying the
BOUND account identity — no credentials, no UI, no user interaction. For an
unbound openid the endpoint SHALL respond `404 binding_required`, which the
client SHALL answer by showing the account sign-in page. The WeChat appid
and secret SHALL be held server-side only; the session key never leaves the
server.

#### Scenario: returning device

- **WHEN** a user whose openid is bound opens the mini program
- **THEN** a fresh wx.login code exchanges for a token with the bound account's identity, with no UI

#### Scenario: first-ever device

- **WHEN** an unbound openid exchanges its wx.login code
- **THEN** the response is `404 binding_required` and the sign-in page is shown

### Requirement: The platform token authenticates REST and WebSocket traffic

Requests from the mini program SHALL carry the platform token, and the
gateway SHALL accept it as a verified identity with the same standing as a
browser's authenticated session: unauthenticated API and WebSocket requests
are rejected, authenticated ones route to the user's cell, and the cell
receives the verified (never client-supplied) identity.

#### Scenario: token-authenticated request reaches the cell

- **WHEN** a REST or WS request carries a valid platform token
- **THEN** it is routed to the account's cell exactly like a browser session, and the cell sees the token-derived verified identity and groups

#### Scenario: missing or invalid token

- **WHEN** an API or WebSocket request arrives without a token or with an expired or forged one
- **THEN** the gateway rejects it with `401` (no login redirect — the client is not a browser) and no cell is contacted

### Requirement: Token expiry renews silently; a dropped binding surfaces as sign-in

Platform tokens SHALL have a bounded lifetime. When a token expires, the
client SHALL re-run the silent exchange (no user interaction) and retry the
failed request once. If the binding was removed (logout elsewhere), the
silent exchange SHALL return `binding_required` and the client SHALL show
the sign-in page instead of surfacing a generic connection error.

#### Scenario: expired token on a REST call

- **WHEN** a REST call returns the authentication-rejected status
- **THEN** the client silently re-authenticates via the bound openid and retries the original request once before surfacing any error

### Requirement: Logout removes the binding

An authenticated logout request (`DELETE /api/mp/bind` with the platform
token) SHALL remove the openid⇄account binding server-side. After logout,
the next launch SHALL return to the sign-in page (the silent path reports
`binding_required`).

#### Scenario: logout on this device

- **WHEN** the user logs out from the mini program
- **THEN** the binding is removed and the next wx.login exchange reports `binding_required`

### Requirement: A bound account shares the browser user's cell

The identity carried by a bound token SHALL be the account email verbatim,
so the mini program and the browser map to the SAME per-user cell (same
model configuration, sessions, history). Distinct accounts SHALL never
share a cell.

#### Scenario: same account, two ends, one dataset

- **WHEN** a user signs into the mini program with the account they use on the web
- **THEN** both ends resolve to the same cell and see the same sessions

### Requirement: The mini-program identity path is disabled without configuration

When the mini-program credentials are not configured on the server, both
login endpoints SHALL report the capability as unavailable and reject
attempts, while all existing browser flows continue to work unchanged.

#### Scenario: no appid/secret configured

- **WHEN** a login attempt arrives at a deployment without mini-program credentials
- **THEN** the endpoint responds with a not-configured error and ordinary Logto browser traffic is unaffected
