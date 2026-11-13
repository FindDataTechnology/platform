# auth 信任边界补内部桥

## MODIFIED Requirements

### Requirement: Trust boundary and scope

The documentation SHALL state that forward-auth identity headers are trusted only when the server is reachable exclusively through the configured proxy. This change SHALL NOT add local passwords, application cookie sessions, user records, or multi-user data isolation. The server SHALL additionally recognize loopback-only internal bridges (`isInternal*Bridge` helpers in `server/auth.js`): their credential SHALL be the loopback source address, their exemption SHALL be scoped to a single verb/path family, the acting identity SHALL be attributed server-side (never taken from `x-forwarded-*` headers), and a real user's request forwarded through the loopback gateway SHALL keep its own identity. Each bridge SHALL carry a named helper and a rationale; adding or widening one SHALL be treated as widening the trust boundary.

#### Scenario: operator enables forward-auth

- **WHEN** an operator enables `AUTH_MODE=forward_auth`
- **THEN** deployment documentation repeats the localhost/firewall trust-boundary requirement

#### Scenario: an internal bridge call keeps the caller's identity honest
- **WHEN** a loopback caller invokes a single-verb internal bridge path
- **THEN** the request SHALL pass the auth gate with a server-derived bridge identity
- **AND** any forwarded identity headers on that request SHALL NOT be trusted
- **AND** a non-loopback caller SHALL still face the full auth gate for the same path
