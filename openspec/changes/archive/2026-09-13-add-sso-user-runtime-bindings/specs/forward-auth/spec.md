## MODIFIED Requirements

### Requirement: Identity from trusted headers

When `AUTH_MODE=forward_auth`, the system SHALL derive the request identity as `email` from `X-Forwarded-Email` and `groups` from the comma-separated `X-Forwarded-Groups` header, and attach it to `req.user` for HTTP handlers and WebSocket connections alike. When `AUTH_MODE=none` and optional SSO identity is enabled, the server SHALL parse the same trusted headers into an internal SSO identity for personal-binding endpoints and WebSocket identity synchronization, but SHALL NOT attach that identity to `req.user`, grant administrator privileges, or turn the application into a hard authentication gate. In both modes, identity headers are trusted only when the server is reachable exclusively through the configured proxy.

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
