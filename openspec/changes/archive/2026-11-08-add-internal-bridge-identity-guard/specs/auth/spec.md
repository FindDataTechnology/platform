# auth 信任边界回写

## MODIFIED Requirements

### Requirement: Trust boundary and scope

The documentation SHALL state that forward-auth identity headers are trusted only when the server is reachable exclusively through the configured proxy. This capability SHALL NOT add local passwords or a platform-owned account lifecycle (registration, password reset, account table); identity is always derived from the proxy, the identity provider, a paired device, or the cell's own internal children. At the same time the platform DOES keep: the identity provider's signed session cookie in `logto` mode (required by this spec's own SSO entry, and never a platform-issued credential), per-identity preference rows keyed by the proxy-derived email (model bindings, MCP availability, registry credentials — preferences, not accounts), and whatever multi-user isolation `tenant-cell-runtime` provides. None of those is an account system.

The server SHALL recognize loopback-only internal bridges: the credential of a bridge caller SHALL be BOTH a loopback source address AND the absence of proxied identity headers (`x-forwarded-email`). The address alone MUST NOT be the credential, because in hosted mode the gateway proxies every real user into their cell from loopback while injecting those headers (`gateway/index.js:1107`, `gateway/proxy.js:59`) — an address-only test cannot tell a cell's child from the cell's owner. Each bridge SHALL be enumerated in one table with the identity it stamps, its verb/path scope, and the route-side attribution that keeps a forged caller from acting as a name it supplies; adding or widening one SHALL be treated as widening the trust boundary. A real user's request forwarded through the loopback gateway SHALL keep its own identity, and SHALL never be stamped with a bridge identity.

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
