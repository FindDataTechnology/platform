# forward-auth

## ADDED Requirements

### Requirement: Opt-in authentication mode

The system SHALL support an `AUTH_MODE` setting. When `AUTH_MODE` is unset or `none`, the server SHALL behave exactly as before (no authentication). When `AUTH_MODE` is `forward_auth`, the server SHALL require a proxy-injected identity on every HTTP request and WebSocket upgrade.

#### Scenario: Auth disabled by default

- **WHEN** the server starts with `AUTH_MODE` unset
- **THEN** all routes and WebSocket connections are served without an identity check, matching pre-change behavior

#### Scenario: Forward-auth mode rejects anonymous requests

- **WHEN** `AUTH_MODE=forward_auth` and a request arrives without an `X-Forwarded-Email` header
- **THEN** the server responds `401` and no route handler or WebSocket upgrade runs

### Requirement: Identity from trusted headers

When `AUTH_MODE=forward_auth`, the system SHALL derive the request identity as `email` from `X-Forwarded-Email` and `groups` from the comma-separated `X-Forwarded-Groups` header, and attach it to the request context for HTTP handlers and WebSocket connections alike.

#### Scenario: Headers populate the request user

- **WHEN** a request carries `X-Forwarded-Email: dev@tokenvault.vip` and `X-Forwarded-Groups: admin,dev`
- **THEN** handlers see `user = { email: "dev@tokenvault.vip", groups: ["admin", "dev"] }`

#### Scenario: WebSocket upgrade is gated identically

- **WHEN** `AUTH_MODE=forward_auth` and a WebSocket upgrade arrives without identity headers
- **THEN** the upgrade is rejected

### Requirement: Identity introspection endpoint

The system SHALL expose `GET /api/auth/me` returning `{ mode, email, groups }` (email and groups null when auth is off) so clients can render login state without inspecting headers.

#### Scenario: Client reads current identity

- **WHEN** any client calls `/api/auth/me` while `AUTH_MODE=forward_auth`
- **THEN** the response contains the requesting user's email and groups

### Requirement: Documented trust boundary

The documentation SHALL state that `AUTH_MODE=forward_auth` asserts the server is reachable only through a forward-auth proxy (e.g. Caddy `forward_auth` → oauth2-proxy → Logto); identity headers arriving by any other path are attacker-controlled.

#### Scenario: Operator enabling forward-auth

- **WHEN** an operator sets `AUTH_MODE=forward_auth`
- **THEN** `.env.example` and the README instruct binding to localhost or firewalling the server so direct requests cannot forge identity headers
