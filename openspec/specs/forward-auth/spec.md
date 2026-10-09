# forward-auth Specification

## Purpose
Provide a discoverable in-application entry and exit for the existing forward-auth SSO flow without adding local authentication.

## Requirements

### Requirement: Opt-in authentication mode
The system SHALL support an `AUTH_MODE` setting. When `AUTH_MODE` is unset or `none`, the server SHALL behave exactly as before (no authentication). When `AUTH_MODE` is `forward_auth`, the server SHALL require a proxy-injected identity on every non-exempt HTTP request and WebSocket upgrade. When `AUTH_MODE` is `logto`, the server SHALL enforce native Logto OIDC login as specified by the `logto-auth` capability (authorization-code redirect, callback exchange, signed session cookie), and SHALL NOT consume proxy-injected identity headers in that mode.

#### Scenario: Auth disabled by default

- **WHEN** the server starts with `AUTH_MODE` unset
- **THEN** all routes and WebSocket connections are served without an identity check, matching pre-change behavior

#### Scenario: Forward-auth mode rejects anonymous requests

- **WHEN** `AUTH_MODE=forward_auth` and a request arrives without an `X-Forwarded-Email` header
- **THEN** the server responds `401` and no protected route handler or WebSocket upgrade runs

#### Scenario: Logto mode ignores injected headers

- **WHEN** `AUTH_MODE=logto` and a request carries forged `X-Forwarded-Email`/`X-Forwarded-Groups` headers but no valid session cookie
- **THEN** the request is treated as unauthenticated (browser requests redirect to Logto sign-in) and the header values are never trusted

### Requirement: Identity from trusted headers

When `AUTH_MODE` is `forward_auth`, the system SHALL derive the request identity as `email` from `X-Forwarded-Email` and `groups` from the comma-separated `X-Forwarded-Groups` header, and attach it to `req.user` for HTTP handlers and WebSocket connections alike. When `AUTH_MODE` is `none` and optional SSO identity is enabled, the server SHALL parse the same trusted headers into an internal SSO identity for personal-binding endpoints and WebSocket identity synchronization, but SHALL NOT attach that identity to `req.user`, grant administrator privileges, or turn the application into a hard authentication gate. In both modes, identity headers are trusted only when the server is reachable exclusively through the configured proxy. When the server runs as a hosted cell (`CLOUD_MODE` set), this reachability restriction SHALL be enforced actively: identity headers are honored only when the request also carries the configured gateway secret, and identity headers from any other source SHALL be treated as absent before authentication decisions are made.

#### Scenario: Headers populate the request user
- **WHEN** a request carries `X-Forwarded-Email: dev@tokenvault.vip` and `X-Forwarded-Groups: admin,dev` while `AUTH_MODE=forward_auth`
- **THEN** handlers see `req.user = { email: "dev@tokenvault.vip", groups: ["admin", "dev"] }`

#### Scenario: WebSocket upgrade is gated identically
- **WHEN** `AUTH_MODE=forward_auth` and a WebSocket upgrade arrives without identity headers
- **THEN** the upgrade is rejected

#### Scenario: Optional SSO headers create an internal identity
- **WHEN** `AUTH_MODE=none`, optional SSO is enabled, and a request carries trusted identity headers
- **THEN** personal-binding handlers see the normalized SSO identity
- **AND** the request is not treated as a forward-auth `req.user`
- **AND** the identity does not grant administrator privileges

#### Scenario: Optional SSO remains anonymous without headers
- **WHEN** `AUTH_MODE=none`, optional SSO is enabled, and a request has no identity headers
- **THEN** the request remains anonymous
- **AND** anonymous chat and global runtime state remain available

#### Scenario: Hosted cell honors identity headers from the gateway
- **WHEN** a hosted cell (`CLOUD_MODE` set) receives a request from the configured gateway carrying `X-Forwarded-Email` and the gateway secret
- **THEN** the server derives the identity from the header as above

#### Scenario: Hosted cell ignores identity headers from unauthorized sources
- **WHEN** a hosted cell receives a request with `X-Forwarded-Email` but without the gateway secret
- **THEN** the server treats the request as having no identity headers
- **AND** a protected request proceeds as unauthenticated (rejected) rather than as the spoofed identity

### Requirement: Public identity and SSO configuration

The system SHALL expose `GET /api/auth/me` without requiring an identity header. The response SHALL contain `mode`, `email`, `groups`, `authenticated`, `loginUrl`, `logoutUrl`, `ssoConfigured`, `ssoAuthenticated`, `ssoEmail`, and `ssoGroups`. `email` and `groups` SHALL be null when the request is anonymous; `authenticated` SHALL be true only when `mode` is `forward_auth` and an email is present. `ssoConfigured` SHALL be true when optional SSO identity is enabled in auth-disabled mode. `ssoAuthenticated`, `ssoEmail`, and `ssoGroups` SHALL describe a trusted optional SSO identity and SHALL NOT be populated from browser-controlled request data.

#### Scenario: Anonymous identity introspection
- **WHEN** `AUTH_MODE=forward_auth` and a client calls `GET /api/auth/me` without identity headers
- **THEN** the response status is `200`
- **AND** `authenticated` is `false`, `email` is `null`, and `groups` is `null`

#### Scenario: Authenticated identity introspection
- **WHEN** `AUTH_MODE=forward_auth` and a client supplies trusted identity headers
- **THEN** the response status is `200`
- **AND** the response contains the supplied email and groups

#### Scenario: Auth-disabled identity introspection
- **WHEN** `AUTH_MODE` is unset or `none` and optional SSO is not enabled
- **THEN** `GET /api/auth/me` returns `mode: "none"`, `authenticated: false`, `ssoConfigured: false`, and null identity fields

#### Scenario: Auth-disabled identity introspection with optional SSO
- **WHEN** `AUTH_MODE=none`, optional SSO is enabled, and a client supplies trusted identity headers
- **THEN** `GET /api/auth/me` returns `mode: "none"`, `authenticated: false`, `ssoConfigured: true`, `ssoAuthenticated: true`, and the supplied SSO email and groups

### Requirement: Protected routes remain protected

The system SHALL continue rejecting every non-exempt HTTP request and WebSocket upgrade that lacks proxy identity when `AUTH_MODE=forward_auth`. `GET /api/auth/me`, `GET /login`, static asset requests, and other `GET`/`HEAD` non-API/non-external SPA shell routes are public so the browser can render the login surface; protected API handlers and WebSocket upgrades remain gated.

#### Scenario: Anonymous protected API

- **WHEN** an anonymous client calls a protected API in forward-auth mode
- **THEN** the server returns `401` and does not invoke the route handler

#### Scenario: Anonymous WebSocket upgrade

- **WHEN** an anonymous client attempts a WebSocket upgrade in forward-auth mode
- **THEN** the upgrade is rejected with HTTP `401`

### Requirement: Configured SSO entry and exit paths

The system SHALL support `AUTH_LOGIN_PATH` and `AUTH_LOGOUT_PATH`, defaulting to `/oauth2/start` and `/oauth2/sign_out`. Values SHALL be same-origin paths beginning with exactly one `/` and SHALL NOT begin with `//`. Invalid values SHALL fall back to the corresponding default.

#### Scenario: Default SSO paths

- **WHEN** the path variables are unset
- **THEN** `/api/auth/me` reports `/oauth2/start` and `/oauth2/sign_out`

#### Scenario: Invalid redirect path

- **WHEN** either path variable is an absolute URL or begins with `//`
- **THEN** the server uses its default path and never returns the invalid value to the browser

### Requirement: In-application login experience

The web UI SHALL provide a `/login` route in every supported locale. In forward-auth mode, an anonymous user SHALL be directed to `/login`; the page SHALL offer a button that navigates to the server-provided login URL. After SSO redirects back, the UI SHALL refresh identity and render the normal application. In auth-disabled mode with optional SSO enabled, the normal application SHALL remain available to anonymous users and SHALL offer an optional login action in the account, model-selection, and welcome surfaces. After an optional SSO redirect, the UI SHALL refresh identity and load the user's personal runtime bindings without forcing anonymous users through the login route.

#### Scenario: Anonymous user reaches the app
- **WHEN** forward-auth is enabled and the browser has no SSO identity
- **THEN** the application renders the localized login page instead of the protected chat shell

#### Scenario: SSO returns to the app
- **WHEN** oauth2-proxy redirects the browser back after authentication
- **THEN** the app reads `/api/auth/me`, sees the email, and enables the appropriate shell

#### Scenario: Optional SSO login is available without blocking anonymous use
- **WHEN** auth is disabled and optional SSO is enabled
- **THEN** an anonymous user can use the chat
- **AND** the UI offers a localized optional login action

### Requirement: Sign-out and account visibility

The authenticated shell SHALL make the current email and a sign-out action available in Settings → Account. Activating sign-out SHALL navigate to the server-provided logout URL with `rd=/login`, close the existing WebSocket, and return the UI to the login state after the proxy redirect. In auth-disabled mode with optional SSO enabled, the account surface SHALL show the open-access state when anonymous and SHALL show the SSO email and sign-out action when a trusted identity is present. Signing out SHALL NOT reset or restore the shared runtime profile.

#### Scenario: Authenticated account action
- **WHEN** a forward-auth user is authenticated
- **THEN** Settings → Account shows the email and a localized sign-out action

#### Scenario: Optional SSO account action
- **WHEN** auth is disabled, optional SSO is enabled, and a trusted identity is present
- **THEN** Settings → Account shows the SSO email and a localized sign-out action

#### Scenario: Sign-out
- **WHEN** the user activates sign-out
- **THEN** the browser navigates to `/oauth2/sign_out?rd=/login` by default and the old WebSocket is closed
- **AND** the shared runtime profile is not reset

### Requirement: Authentication-aware WebSocket lifecycle

The frontend SHALL not open a WebSocket while authentication state is loading or while forward-auth is anonymous. It SHALL open after an authenticated identity is known and after auth-disabled mode is known. In optional SSO mode, the frontend SHALL open a WebSocket for anonymous use and SHALL close and reopen it after login or sign-out so the server fixes identity at upgrade time. A login or sign-out SHALL close the previous socket before the next navigation/state transition.

#### Scenario: Anonymous forward-auth load
- **WHEN** the app starts without an identity in forward-auth mode
- **THEN** no WebSocket connection is attempted

#### Scenario: Authenticated return
- **WHEN** `/api/auth/me` reports an authenticated forward-auth user
- **THEN** the WebSocket connects and the existing session synchronization occurs

#### Scenario: Optional SSO anonymous load
- **WHEN** auth is disabled and optional SSO is enabled
- **THEN** the anonymous WebSocket connects and receives global runtime state

#### Scenario: Optional SSO login reconnect
- **WHEN** an optional SSO identity becomes available
- **THEN** the frontend closes the anonymous socket and opens a new socket
- **AND** the new socket receives the identity-scoped binding snapshot

### Requirement: Documented trust boundary and scope

The documentation SHALL state that forward-auth and optional SSO identity headers are trusted only when the server is reachable exclusively through the configured proxy. Binding endpoints and WebSocket identity SHALL use only server-derived identity. This change SHALL NOT add local passwords, Platform-owned sessions, user account records, per-user data isolation, or administrator privileges for optional SSO identities.

#### Scenario: Operator enables optional SSO
- **WHEN** an operator enables optional SSO identity
- **THEN** deployment documentation states that anonymous requests must reach Platform while trusted identity headers are injected by the proxy

#### Scenario: Operator enabling forward-auth
- **WHEN** an operator enables `AUTH_MODE=forward_auth`
- **THEN** deployment documentation repeats the localhost/firewall trust-boundary requirement
