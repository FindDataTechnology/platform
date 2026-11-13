# miniprogram-auth Delta: single-process deployments

The identity path this capability defines is no longer gateway-only: the same
account-binding contracts SHALL hold on a single-process deployment
(`AUTH_MODE=logto`) — one shared runtime, no per-user cells — so a mini-program
client can sign in to either deployment shape. The gateway's per-user routing
requirements are preserved verbatim where they apply; the deltas below
generalize the wording and add the single-process + client-probe requirements.

## RENAMED Requirements

- FROM: `### Requirement: A bound account shares the browser user's cell`
- TO: `### Requirement: A bound account shares the browser user's data`

## MODIFIED Requirements

### Requirement: First sign-in redeems a bind code minted from the web session

The platform identity provider (Logto) offers no password grant (deprecated
in OAuth 2.1), so credentials never enter the mini program. Instead, an
authenticated WEB session SHALL mint a single-use 6-digit bind code
(`GET /api/mp/bindcode`, 5-minute validity, bound to the signed-in account)
on any deployment shape whose identity path is configured. The mini
program's login page SHALL redeem that code together with a fresh
`wx.login` code at `POST /api/mp/login-bindcode`; the server — the gateway
or a single-process deployment — SHALL then bind the WeChat openid to the
account (persisted server-side, surviving restarts, in that deployment's
own data store) and issue a platform token carrying the ACCOUNT identity
(email + groups). A wrong, expired, or already-redeemed code SHALL be
rejected with `401` and SHALL NOT create a binding; a malformed code SHALL
be rejected with `400`.

#### Scenario: successful first sign-in

- **WHEN** the user enters a valid bind code from their signed-in web session
- **THEN** the server binds the openid to that account and returns a platform token whose identity is the account's email and groups

#### Scenario: wrong, expired, or reused code leaves nothing behind

- **WHEN** the user enters an incorrect, expired, or already-redeemed bind code
- **THEN** the endpoint responds `401` and the openid remains unbound

#### Scenario: binding survives a single-process restart

- **WHEN** an openid was bound on a single-process deployment and the server restarts
- **THEN** the binding is still resolvable and the next silent launch succeeds without a new bind code

### Requirement: The platform token authenticates REST and WebSocket traffic

Requests from the mini program SHALL carry the platform token, and the server
— the gateway or a single-process deployment — SHALL accept it as a verified
identity with the same standing as a browser's authenticated session:
unauthenticated API and WebSocket requests are rejected with `401` (no login
redirect — the client is not a browser), and authenticated ones proceed with
the token-derived verified identity (never client-supplied) driving the
deployment's authorization decisions (admin gating, role-filtered rosters).
On the gateway, authenticated requests route to the user's cell exactly as
browser sessions do; on a single-process deployment they reach the one
shared runtime.

#### Scenario: token-authenticated request reaches the cell

- **WHEN** a REST or WS request carries a valid platform token
- **THEN** it is served exactly like the same account's browser session — routed to the account's cell (gateway) or the shared runtime (single-process) — and authorization decisions see the token-derived identity and groups

#### Scenario: missing or invalid token

- **WHEN** an API or WebSocket request arrives without a token or with an expired or forged one
- **THEN** the server rejects it with `401` (no login redirect — the client is not a browser) and no runtime state is touched on the request's behalf

#### Scenario: WebSocket upgrade with a platform token

- **WHEN** a single-process deployment receives a WebSocket upgrade carrying a valid platform token in the Authorization header
- **THEN** the upgrade is accepted and the connection carries the token-derived identity, with the same standing as a cookie-authenticated browser connection

### Requirement: A bound account shares the browser user's data

The identity carried by a bound token SHALL be the account email verbatim,
so the mini program and the browser resolve to the SAME dataset: on the
gateway, the same per-user cell (same model configuration, sessions,
history); on a single-process deployment, the same shared runtime. Distinct
accounts SHALL never share a cell on the gateway.

#### Scenario: same account, two ends, one dataset

- **WHEN** a user signs into the mini program with the account they use on the web
- **THEN** both ends resolve to the same dataset — the same cell (gateway) or the same runtime (single-process) — and see the same sessions

## ADDED Requirements

### Requirement: The single-process server exposes the mini-program identity endpoints

A single-process deployment with `AUTH_MODE=logto` and the mini-program
credentials configured SHALL expose the same four endpoints as the gateway,
with identical request/response contracts: `GET /api/mp/bindcode` (minted
from an authenticated browser session or platform token), `POST /api/mp/login`
and `POST /api/mp/login-bindcode` (reachable WITHOUT any browser session —
the mini program has none), and `DELETE /api/mp/bind`. The login endpoints
SHALL be exempt from the session-cookie requirement while carrying their own
authentication (the wx.login exchange / bind code). Openid⇄account bindings
SHALL persist in the deployment's data directory (or its dev-mode fallback)
across restarts, in the same file format the gateway uses.

#### Scenario: login endpoints answer without a browser session

- **WHEN** the mini program calls `/api/mp/login` or `/api/mp/login-bindcode` on a single-process deployment with no session cookie
- **THEN** the call is answered on its own merits (token issued, `binding_required`, or a validation error) — not rejected for a missing browser session

#### Scenario: bind-code minting still requires a signed-in web user

- **WHEN** an unauthenticated request asks `/api/mp/bindcode` for a code on a single-process deployment
- **THEN** the request is rejected (`401` for programmatic callers, login redirect for browsers) and no code is minted

### Requirement: The client boot probe reports the auth mode explicitly

The mini program's boot probe SHALL be the identity endpoint
(`/api/auth/me`), not the public config endpoint: the config endpoint is
public on single-process deployments (the browser SPA needs it pre-login)
and therefore cannot signal an auth requirement. When the probe reports no
auth requirement (`mode: "none"`, or an equivalent unauthenticated-OK
response), the client SHALL connect without a token; when it reports an
auth requirement (`mode: "logto"`, or `401` — the gateway's anonymous
answer), the client SHALL run the silent login exchange before connecting.
The public config endpoint SHALL remain public on single-process
deployments so the browser SPA is unaffected.

#### Scenario: single-process logto deployment

- **WHEN** the mini program boots against a single-process `AUTH_MODE=logto` deployment and probes the identity endpoint anonymously
- **THEN** the response reports the logto auth mode and the client runs the silent login (or shows the bind-code page when unbound) instead of assuming no auth

#### Scenario: no-auth deployment

- **WHEN** the mini program boots against a deployment whose probe reports `mode: "none"`
- **THEN** the client connects without attempting any login

#### Scenario: gateway (anonymous probe rejected)

- **WHEN** the mini program boots against the gateway and the anonymous probe is rejected with `401`
- **THEN** the client runs the silent login, exactly as before this requirement existed
