# miniprogram-auth Specification

## Purpose

WeChat login for mini-program clients, built on ACCOUNT BINDING to the
platform identity provider (Logto): the first launch on a device redeems a
one-time bind code minted from the user's signed-in web session, the server
binds the WeChat openid to that account, and every later launch is a silent
wx.login exchange. Tokens carry the ACCOUNT identity — the same
email/groups as the web session — so a user shares one dataset across the
mini program and the browser. The identity path exists on BOTH deployment
shapes — the multi-tenant gateway (per-user cells) and the single-process
`AUTH_MODE=logto` server (one shared runtime) — with one shared
implementation behind both. Browsers keep using the existing Logto redirect
flow; this capability adds a second, mini-program-only door.

## Requirements

### Requirement: First sign-in redeems a bind code minted from the web session

The platform identity provider (Logto) offers no password grant (deprecated
in OAuth 2.1), so credentials never enter the mini program. Instead, an
authenticated WEB session SHALL mint a single-use 6-digit bind code
(`GET /api/mp/bindcode`, 5-minute validity, bound to the signed-in account)
on any deployment shape whose identity path is configured. The same code is
the payload of BOTH presentation forms: the numeric code for manual entry,
and a QR encoding of `<web-origin>/settings/wechat-app?bindcode=<code>` for
scanning (see `settings-surface`). The mini program's first sign-in SHALL
redeem that code together with a fresh `wx.login` code at
`POST /api/mp/login-bindcode`; the server — the gateway or a single-process
deployment — SHALL then bind the WeChat openid to the account (persisted
server-side, surviving restarts, in that deployment's own data store) and
issue a platform token carrying the ACCOUNT identity (email + groups). A
wrong, expired, or already-redeemed code SHALL be rejected with `401` and
SHALL NOT create a binding; a malformed code SHALL be rejected with `400`.

The login page SHALL offer scan-to-bind as the PRIMARY action
（【扫码绑定】, `wx.scanCode`）, with manual 6-digit entry as the visible
fallback. The scanner's payload SHALL be parsed to a bind code by accepting,
in order: a URL whose query carries `bindcode=<6 digits>`; a bare 6-digit
payload; a payload whose last path segment or fragment is 6 digits. A scan
result that yields no 6-digit code SHALL be reported as a clear message and
SHALL leave the login form unchanged — never a silent failure. Bind success
SHALL navigate the user back to the chat page automatically. The login
page's guidance copy SHALL name the web location in user terms — the site
URL with 设置 → 微信小程序 — and SHALL NOT surface bare API paths such as
`/api/mp/bindcode`.

#### Scenario: successful first sign-in

- **WHEN** the user redeems a valid bind code from their signed-in web session — by scanning the web Settings QR or by typing the digits
- **THEN** the server binds the openid to that account and returns a platform token whose identity is the account's email and groups

#### Scenario: scanning the web Settings QR

- **WHEN** the user taps 扫码绑定 and scans the web Settings QR carrying `?bindcode=482913`
- **THEN** the client redeems the parsed code via the existing `login-bindcode` exchange and the user is returned to the chat page signed in — with no digits typed

#### Scenario: an unscannable payload says so

- **WHEN** the scanner returns a payload that yields no 6-digit code (e.g. a plain URL without `bindcode`, or free text)
- **THEN** the login page shows a message naming the problem and the manual field stays usable
- **AND** no exchange request is sent

#### Scenario: wrong, expired, or reused code leaves nothing behind

- **WHEN** the user redeems an incorrect, expired, or already-redeemed bind code — scanned or typed
- **THEN** the endpoint responds `401` and the openid remains unbound

#### Scenario: binding survives a single-process restart

- **WHEN** an openid was bound on a single-process deployment and the server restarts
- **THEN** the binding is still resolvable and the next silent launch succeeds without a new bind code

### Requirement: Bound openids log in silently; unbound ones are asked to sign in

For a client whose openid is bound, the silent path SHALL exchange a fresh
`wx.login` code (`POST /api/mp/login`) for a platform token carrying the
BOUND account identity — no credentials, no UI, no user interaction. For an
unbound openid on a deployment without an accountless sandbox the endpoint
SHALL respond `404 binding_required`, and the client SHALL NOT auto-navigate
to a sign-in page — the chat page stays browsable with a user-initiated
sign-in affordance (see `mp-demo-sandbox` for the sandbox-first landing that
replaces the parked-unbound state where the sandbox is deployed).

The sign-in page SHALL offer an explicit way back ("暂不登录") so the flow is
never a dead end. The WeChat appid and secret SHALL be held server-side
only; the session key never leaves the server.

#### Scenario: returning device

- **WHEN** a user whose openid is bound opens the mini program
- **THEN** a fresh wx.login code exchanges for a token with the bound account's identity, with no UI

#### Scenario: first-ever device

- **WHEN** an unbound openid exchanges its wx.login code on a deployment without demo mode
- **THEN** the response is `404 binding_required`, the chat page stays browsable with a sign-in affordance, and no automatic navigation to the sign-in page occurs

#### Scenario: first-ever device with demo mode

- **WHEN** an unbound openid exchanges its wx.login code on a demo-enabled deployment
- **THEN** the response carries a demo-scoped token and the user can chat without ever seeing a sign-in page

#### Scenario: unbound user tries to send without demo mode

- **WHEN** an unbound user on a non-demo deployment taps send on the browsable chat page
- **THEN** the client navigates to the sign-in page (user-initiated), which offers a way back to browsing

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

### Requirement: Token expiry renews silently; a dropped binding surfaces as sign-in

Platform tokens SHALL have a bounded lifetime. When a token expires, the
client SHALL re-run the silent exchange (no user interaction) and retry the
failed request once. If the binding was removed (logout elsewhere), the
silent exchange SHALL return `binding_required` — or, on a demo-enabled
deployment, a fresh demo-scoped token — and the client SHALL show the
sign-in affordance (or continue in demo mode) instead of surfacing a generic
connection error.

#### Scenario: expired token on a REST call

- **WHEN** a REST call returns the authentication-rejected status
- **THEN** the client silently re-authenticates via the bound openid and retries the original request once before surfacing any error

#### Scenario: binding dropped on a demo deployment

- **WHEN** a user whose binding was removed re-runs the silent exchange on a demo-enabled deployment
- **THEN** the exchange returns a demo-scoped token and the user continues in demo mode without an error state

### Requirement: Logout removes the binding

An authenticated logout request (`DELETE /api/mp/bind` with the platform
token) SHALL remove the openid⇄account binding server-side. After logout,
the next launch SHALL return to the sign-in-required state — or, on a
demo-enabled deployment, to demo mode via the silent demo token.

#### Scenario: logout on this device

- **WHEN** the user logs out from the mini program
- **THEN** the binding is removed and the next wx.login exchange reports `binding_required`, or resolves to demo mode on a demo-enabled deployment

### Requirement: A bound account shares the browser user's data

The identity carried by a bound token SHALL be the account email verbatim,
so the mini program and the browser resolve to the SAME dataset: on the
gateway, the same per-user cell (same model configuration, sessions,
history); on a single-process deployment, the same shared runtime. Distinct
accounts SHALL never share a cell on the gateway.

#### Scenario: same account, two ends, one dataset

- **WHEN** a user signs into the mini program with the account they use on the web
- **THEN** both ends resolve to the same dataset — the same cell (gateway) or the same runtime (single-process) — and see the same sessions

### Requirement: The mini-program identity path is disabled without configuration

When the mini-program credentials are not configured on the server, both
login endpoints SHALL report the capability as unavailable and reject
attempts, while all existing browser flows continue to work unchanged.

#### Scenario: no appid/secret configured

- **WHEN** a login attempt arrives at a deployment without mini-program credentials
- **THEN** the endpoint responds with a not-configured error and ordinary Logto browser traffic is unaffected

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
