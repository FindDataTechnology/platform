# auth Specification

## Purpose
Provide a discoverable in-application entry and exit for the existing forward-auth SSO flow without adding local authentication.

## Requirements

### Requirement: Public identity and SSO configuration
The system SHALL expose `GET /api/auth/me` without requiring an identity header. The response SHALL contain `mode`, `email`, `groups`, `authenticated`, `loginUrl`, and `logoutUrl`. `email` and `groups` SHALL be null when the request is anonymous; `authenticated` SHALL be true when `mode` is `forward_auth` and an email is present, or when `mode` is `logto` and a valid session cookie is present. Under `logto` mode, `loginUrl` SHALL be the server's local redirect initiator (`/auth/login`, which forwards to the Logto authorization endpoint) and `logoutUrl` SHALL be the server's logout route (`/api/auth/logout`); under other modes the existing `AUTH_LOGIN_PATH`/`AUTH_LOGOUT_PATH` values apply. Session identity under `logto` mode SHALL feed `req.user`/`ws.user` and downstream consumers (role visibility, admin gate, personal runtime bindings) identically to forward-auth identity.

Under `logto` mode, the local redirect initiator SHALL accept a `rd` same-origin return path, carry it through the signed state cookie, and after a successful callback validate that it is a relative path beginning with exactly one `/` and not beginning with `//` before redirecting to it; an absent, invalid, or mismatched `rd` SHALL redirect to `/`. The authorization redirect SHALL pass the browser's resolved UI locale as `ui_locales` when the request supplies one (query parameter), so the hosted sign-in page language follows the user's choice.

#### Scenario: anonymous identity introspection

- **WHEN** `AUTH_MODE=forward_auth` and a client calls `GET /api/auth/me` without identity headers
- **THEN** the response status is `200`
- **AND** `authenticated` is `false`, `email` is `null`, and `groups` is `null`

#### Scenario: authenticated identity introspection

- **WHEN** `AUTH_MODE=forward_auth` and a client supplies trusted identity headers
- **THEN** the response status is `200`
- **AND** the response contains the supplied email and groups

#### Scenario: auth-disabled identity introspection

- **WHEN** `AUTH_MODE` is unset or `none`
- **THEN** `GET /api/auth/me` returns `mode: "none"`, `authenticated: false`, and null identity fields

#### Scenario: logto session introspection

- **WHEN** `AUTH_MODE=logto` and a client calls `GET /api/auth/me` with a valid session cookie
- **THEN** the response contains `mode: "logto"`, `authenticated: true`, the session's email and groups, `loginUrl: "/auth/login"`, and `logoutUrl: "/api/auth/logout"`

#### Scenario: logto anonymous introspection

- **WHEN** `AUTH_MODE=logto` and a client calls `GET /api/auth/me` without a valid session
- **THEN** the response contains `mode: "logto"`, `authenticated: false`, and null email/groups

#### Scenario: logto returns to the requested page

- **WHEN** `AUTH_MODE=logto` and the client initiates login with `rd=/chat/abc123`
- **THEN** after the Logto callback completes the browser is redirected to `/chat/abc123`

#### Scenario: invalid return path falls back to root

- **WHEN** the login request carries `rd=https://evil.example` or `rd=//evil.example` or no `rd`
- **THEN** the post-callback redirect lands on `/`

#### Scenario: hosted page follows the UI locale

- **WHEN** the login redirect is initiated with a `ui_locales` hint from the browser's resolved locale
- **THEN** the authorization redirect includes that `ui_locales` parameter

### Requirement: Protected routes remain protected

The system SHALL continue rejecting every non-exempt HTTP request and WebSocket upgrade that lacks proxy identity when `AUTH_MODE=forward_auth`. `GET /api/auth/me`, `GET /login`, static asset requests, and other `GET`/`HEAD` non-API/non-external SPA shell routes are public so the browser can render the login surface; protected API handlers and WebSocket upgrades remain gated.

#### Scenario: anonymous protected API

- **WHEN** an anonymous client calls a protected API in forward-auth mode
- **THEN** the server returns `401` and does not invoke the route handler

#### Scenario: anonymous WebSocket upgrade

- **WHEN** an anonymous client attempts a WebSocket upgrade in forward-auth mode
- **THEN** the upgrade is rejected with HTTP `401`

### Requirement: Configured SSO entry and exit paths

The system SHALL support `AUTH_LOGIN_PATH` and `AUTH_LOGOUT_PATH`, defaulting to `/oauth2/start` and `/oauth2/sign_out`. Values SHALL be same-origin paths beginning with exactly one `/` and SHALL NOT begin with `//`. Invalid values SHALL fall back to the corresponding default.

#### Scenario: default SSO paths

- **WHEN** the path variables are unset
- **THEN** `/api/auth/me` reports `/oauth2/start` and `/oauth2/sign_out`

#### Scenario: invalid redirect path

- **WHEN** either path variable is an absolute URL or begins with `//`
- **THEN** the server uses its default path and never returns the invalid value to the browser

### Requirement: In-application login experience

The web UI SHALL provide a `/login` route in every supported locale. In forward-auth mode, an anonymous user SHALL be directed to `/login`; the page SHALL offer a button that navigates to the server-provided login URL. After SSO redirects back, the UI SHALL refresh identity and render the normal application.

#### Scenario: anonymous user reaches the app

- **WHEN** forward-auth is enabled and the browser has no SSO identity
- **THEN** the application renders the localized login page instead of the protected chat shell

#### Scenario: SSO returns to the app

- **WHEN** oauth2-proxy redirects the browser back after authentication
- **THEN** the app reads `/api/auth/me`, sees the email, and enables the protected shell

### Requirement: Sign-out and account visibility

The authenticated shell SHALL make the current email and a sign-out action available in Settings → Account. Activating sign-out SHALL navigate to the server-provided logout URL with `rd=/login`, close the existing WebSocket, and return the UI to the login state after the proxy redirect. `AUTH_MODE=none` SHALL show the open-access state without an SSO action.

#### Scenario: authenticated account action

- **WHEN** a forward-auth user is authenticated
- **THEN** Settings → Account shows the email and a localized sign-out action

#### Scenario: sign-out

- **WHEN** the user activates sign-out
- **THEN** the browser navigates to `/oauth2/sign_out?rd=/login` by default and the old WebSocket is closed

### Requirement: Authentication-aware WebSocket lifecycle

The frontend SHALL not open a WebSocket while authentication state is loading or while forward-auth is anonymous. It SHALL open after an authenticated identity is known and after auth-disabled mode is known. A login or sign-out SHALL close the previous socket before the next navigation/state transition.

#### Scenario: anonymous forward-auth load

- **WHEN** the app starts without an identity
- **THEN** no WebSocket connection is attempted

#### Scenario: authenticated return

- **WHEN** `/api/auth/me` reports an authenticated user
- **THEN** the WebSocket connects and the existing session synchronization occurs

### Requirement: Trust boundary and scope

The documentation SHALL state that forward-auth identity headers are trusted only when the server is reachable exclusively through the configured proxy. This capability SHALL NOT add local passwords or a platform-owned account lifecycle (registration, password reset, account table); identity is always derived from the proxy, the identity provider, a paired device, or the cell's own internal children. At the same time the platform DOES keep: the identity provider's signed session cookie in `logto` mode (required by this spec's own SSO entry, and never a platform-issued credential), per-identity preference rows keyed by the proxy-derived email (model bindings, MCP availability, registry credentials — preferences, not accounts), and whatever multi-user isolation `tenant-cell-runtime` provides. None of those is an account system.

The server SHALL recognize loopback-only internal bridges: the credential of a bridge caller SHALL be BOTH a loopback source address AND the absence of proxied identity headers (`x-forwarded-email`). The address alone MUST NOT be the credential, because in hosted mode the gateway proxies every real user into their cell from loopback while injecting those headers (`gateway/index.js:1107`, `gateway/proxy.js:59`) — an address-only test cannot tell a cell's child from the cell's owner. Each bridge SHALL be enumerated in one table with the identity it stamps, its verb/path scope, and the route-side attribution that keeps a forged caller from acting as a name it supplies; adding or widening one SHALL be treated as widening the trust boundary. A real user's request forwarded through the loopback gateway SHALL keep its own identity, and SHALL never be stamped with a bridge identity.

The table, as implemented (`INTERNAL_BRIDGES` in `server/auth.js` — every matcher composes the same `isInternalChild` guard, so a new bridge cannot arrive with a weaker caller test):

**Internal bridges.**

| Bridge identity | Verb / path scope | Route-side attribution |
| --- | --- | --- |
| `cron@internal` | any verb on `/api/cron` and `/api/cron/*` | routes act on this cell's own jobs |
| `chart-bridge@internal` | any verb on `/api/resources/bind-declared` | acts on the current turn's chart only |
| `delegation@internal` | any verb on `/api/delegation/*` | task engine's manual path, cell-scoped |
| `fleet-architect@internal` | any verb on `/api/fleet-architect/*` | acting owner resolved server-side from the cell context |
| `builder-author@internal` | any verb on `/api/blueprint-author/*` and `/api/pack-author/*` | draft landing only — no approve/publish/mint verb |
| `skill-evolution@internal` | `POST /api/skill-evolution/propose` | propose verb only — evaluate/promote/reject need a real user |
| `persona-evolution@internal` | `POST /api/persona-evolution/propose` | propose verb only, same rule as the skill lane |
| `save-bridge@internal` | any verb on `/api/resources/save-declared` | session resolved server-side |
| `actions-bridge@internal` | `POST /api/actions/propose` | one verb, pending proposals only; the proposer comes from the child's profile env |
| `input-request-bridge@internal` | `POST /api/input-requests`; `GET /api/input-requests/:id` and `/api/input-requests/:id/wait` | create + read/wait only; the owner comes from the child's per-user profile env. Answering and cancelling never pass this door — they require a real signed-in identity, or everyone sharing a session could fill in someone else's card |
| `fleet-bridge@internal` | `POST` on `/api/fleets/report`, `/api/fleets/escalate`, `/api/fleets/dispatch`, `/api/fleets/deputy/queue`, `/api/fleets/deputy/resolve`, `/api/fleets/deputy/escalate-to-owner` | post attributed server-side; the deputy routes are additionally guarded by `deputyGuard` |

The bridge table SHALL NOT be the only ledger. Every entry by which a request can acquire (or be denied) an identity SHALL be recorded in the same requirement, because a door that is not written down is a door nobody audits:

**Auth-exempt prefixes.** A path prefix the gate skips wholesale SHALL be listed with its own credential mechanism and its failure posture. A prefix SHALL authenticate itself before the route reads or returns data; the only prefix that MAY carry no credential is one that serves no data at all (a public asset). A prefix that neither authenticates itself nor is data-free SHALL be gated instead of exempted. The list, as implemented (`AUTH_EXEMPT_PREFIXES` in `server/auth.js`):

| Prefix | Its own credential | Fail posture |
| --- | --- | --- |
| `/chart-assets/` | none — static chart-rendering library, no data | always public |
| `/api/bots/webhook/` | per-bot path secret + the chat platform's signature/decryption | identical refusal for unknown/disabled/bad secret |
| `/api/bots/relay/` | bearer (`BOT` relay token) | 401 |
| `/api/mp/login`, `/api/mp/login-bindcode` | the platform's own `wx.login` code2session exchange (+ bind code) | 503 when MP credentials absent |
| `/api/app/pair`, `/api/app/challenge`, `/api/app/login` | device pairing bind code / device-key challenge signature | 503 when no token secret |
| `/api/ops/` | bearer (`PACK_USAGE_TOKEN`) | 503 unconfigured, 401 wrong |
| `/local-registry/` | bearer (`WANXING_LOCAL_FEED_TOKEN`); loopback-only when never minted | 401 |
| `/api/trial-exec` | `x-facet-token` (internal service credential) | 401 |
| `/api/actions/mandate-verdict` | bearer (`MANDATE_VERDICT_TOKEN`, constant-time) | 503 unconfigured, 401 wrong |

**Identity doors.** Every way an identity enters, or a request is admitted without one, SHALL be listed with its credential, the condition under which it counts, and what happens when it fails:

| Door | Credential | Counts when | On failure |
| --- | --- | --- | --- |
| Proxied identity headers (`x-forwarded-email`/`-groups`/`-roles`/`-role-admin`/`-layout`) | gateway secret (`x-cloud-gateway-secret`, constant-time) | hosted mode sets a secret | headers treated as absent entirely |
| Identity-provider session cookie | provider-signed cookie | `AUTH_MODE=logto` | 401 (`/api/`) or redirect (`html`) |
| Mini-program bearer | platform-issued token, verified server-side | MP credentials configured | identity is null |
| Paired device bearer | device key / bind code | device-auth credentials configured | identity is null |
| Internal bridges (the table above) | loopback AND no `x-forwarded-email` | always | falls through to the normal gate |
| Auth disabled | none — the machine owner | auth explicitly off | admin/manage gates admit everyone (documented, never implicit in hosted mode) |
| Cell-owner MCP management | `req.user.email` equals the cell's owner email | hosted cell | 403 |
| Admin gate | admin group membership or the role-admin claim | auth enabled | 403 |
| Business roles (`x-forwarded-roles`) | the same gateway secret as the identity pair | hosted mode | header ignored |
| Deployment layout (`x-forwarded-layout`) | the same gateway secret | hosted mode | malformed value degrades to "no header" |

A shared secret SHALL be compared through one constant-time implementation; a route that re-implements the comparison inline SHALL be treated as drift. Adding, widening, or exempting any entry above SHALL be treated as widening the trust boundary, and the change SHALL update this requirement in the same landing.

#### Scenario: operator enables forward-auth

- **WHEN** an operator enables `AUTH_MODE=forward_auth`
- **THEN** deployment documentation repeats the localhost/firewall trust-boundary requirement

#### Scenario: an internal bridge call keeps the caller's identity honest

- **WHEN** a loopback caller invokes a single-verb internal bridge path
- **THEN** the request SHALL pass the auth gate with a server-derived bridge identity
- **AND** any forwarded identity headers on that request SHALL NOT be trusted
- **AND** a non-loopback caller SHALL still face the full auth gate for the same path

#### Scenario: a proxied user on a bridge path is not the bridge

- **WHEN** a request arrives from a loopback address carrying `x-forwarded-email` (the shape the hosted gateway produces for every real user)
- **THEN** the auth gate SHALL NOT stamp it with any bridge identity
- **AND** it SHALL be authenticated as that user through the normal gate, or refused when the identity cannot be verified
- **AND** the same request without the identity header, from loopback, SHALL still be admitted as the bridge's child caller

#### Scenario: a bridge's body-supplied identity is reachable only from the child

- **WHEN** a bridge route accepts the acting identity from the request body because an internal caller supplies it
- **THEN** that path SHALL be reachable only by a caller satisfying both halves of the bridge credential
- **AND** a proxied user SHALL NEVER be able to name another identity through it

#### Scenario: an exempt prefix authenticates itself

- **WHEN** a path prefix is skipped by the auth gate
- **THEN** the route behind it SHALL verify its own credential before reading or returning data, or the prefix SHALL serve no data at all
- **AND** a prefix with no credential that answers with data SHALL be treated as a defect, not a posture
- **AND** the prefix SHALL be listed in this requirement's table with its mechanism and failure posture

#### Scenario: shared secrets compare in constant time

- **WHEN** any route compares a caller-supplied shared secret against configuration
- **THEN** the comparison SHALL go through the single constant-time implementation
- **AND** a route comparing with an ordinary equality operator SHALL be treated as drift and fixed

#### Scenario: the ledger and the code agree

- **WHEN** a new auth-exempt prefix, identity door, or internal bridge is added to the code
- **THEN** the corresponding table in this requirement SHALL be updated in the same landing
- **AND** a check SHALL fail when the implemented set and the documented set diverge
