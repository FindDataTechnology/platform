## MODIFIED Requirements

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
