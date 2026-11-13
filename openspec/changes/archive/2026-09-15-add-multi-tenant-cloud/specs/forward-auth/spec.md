# forward-auth Specification

## MODIFIED Requirements

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
