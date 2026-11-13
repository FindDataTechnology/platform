## MODIFIED Requirements

### Requirement: Public identity and SSO configuration
The system SHALL expose `GET /api/auth/me` without requiring an identity header. The response SHALL contain `mode`, `email`, `groups`, `authenticated`, `loginUrl`, and `logoutUrl`. `email` and `groups` SHALL be null when the request is anonymous; `authenticated` SHALL be true when `mode` is `forward_auth` and an email is present, or when `mode` is `logto` and a valid session cookie is present. Under `logto` mode, `loginUrl` SHALL be the server's local redirect initiator (`/auth/login`, which forwards to the Logto authorization endpoint) and `logoutUrl` SHALL be the server's logout route (`/api/auth/logout`); under other modes the existing `AUTH_LOGIN_PATH`/`AUTH_LOGOUT_PATH` values apply. Session identity under `logto` mode SHALL feed `req.user`/`ws.user` and downstream consumers (role visibility, admin gate, personal runtime bindings) identically to forward-auth identity.

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
