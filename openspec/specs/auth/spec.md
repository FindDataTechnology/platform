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

The documentation SHALL state that forward-auth identity headers are trusted only when the server is reachable exclusively through the configured proxy. This change SHALL NOT add local passwords, application cookie sessions, user records, or multi-user data isolation.

#### Scenario: operator enables forward-auth

- **WHEN** an operator enables `AUTH_MODE=forward_auth`
- **THEN** deployment documentation repeats the localhost/firewall trust-boundary requirement
