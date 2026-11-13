# forward-auth 信任边界台账

## MODIFIED Requirements

### Requirement: Documented trust boundary and scope

The documentation SHALL state that forward-auth and optional SSO identity headers are trusted only when the server is reachable exclusively through the configured proxy. Binding endpoints and WebSocket identity SHALL use only server-derived identity. This change SHALL NOT add local passwords, Platform-owned sessions, user account records, per-user data isolation, or administrator privileges for optional SSO identities. The server SHALL maintain an explicit exemption list (`AUTH_EXEMPT_PREFIXES` in `server/auth.js`); each exempt prefix SHALL carry a code-comment rationale naming the caller that cannot present proxy identity (mini-program login, bot webhook/relay, app pairing, public static assets, the in-cell loopback cron bridge). The loopback internal bridge SHALL additionally verify the source address is loopback so the exemption never widens beyond the cell's own node. Adding an exemption widens the trust boundary and SHALL be documented alongside the change.

#### Scenario: Operator enables optional SSO
- **WHEN** an operator enables optional SSO identity
- **THEN** deployment documentation states that anonymous requests must reach Platform while trusted identity headers are injected by the proxy

#### Scenario: Operator enabling forward-auth
- **WHEN** an operator enables `AUTH_MODE=forward_auth`
- **THEN** deployment documentation repeats the localhost/firewall trust-boundary requirement

#### Scenario: An exemption is added
- **WHEN** a developer adds a prefix to `AUTH_EXEMPT_PREFIXES`
- **THEN** the entry SHALL carry a rationale naming the caller and why it cannot present proxy identity
- **AND** a non-loopback caller SHALL still face the full auth gate for every path outside the exemption
