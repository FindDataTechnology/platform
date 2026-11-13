## MODIFIED Requirements

### Requirement: Trust boundary and scope

The documentation SHALL state that forward-auth identity headers are trusted only when the server is reachable exclusively through the configured proxy. This capability SHALL NOT add local passwords or a platform-owned account lifecycle (registration, password reset, account table); identity is always derived from the proxy, the identity provider, a paired device, or the cell's own internal children. At the same time the platform DOES keep: the identity provider's signed session cookie in `logto` mode (required by this spec's own SSO entry, and never a platform-issued credential), per-identity preference rows keyed by the proxy-derived email (model bindings, MCP availability, registry credentials — preferences, not accounts), and whatever multi-user isolation `tenant-cell-runtime` provides. None of those is an account system.

The server SHALL recognize loopback-only internal bridges: the credential of a bridge caller SHALL be BOTH a loopback source address AND the absence of proxied identity headers (`x-forwarded-email`). The address alone MUST NOT be the credential, because in hosted mode the gateway proxies every real user into their cell from loopback while injecting those headers (`gateway/index.js:1107`, `gateway/proxy.js:59`) — an address-only test cannot tell a cell's child from the cell's owner. Each bridge SHALL be enumerated in one table with the identity it stamps, its verb/path scope, and the route-side attribution that keeps a forged caller from acting as a name it supplies; adding or widening one SHALL be treated as widening the trust boundary. A real user's request forwarded through the loopback gateway SHALL keep its own identity, and SHALL never be stamped with a bridge identity.

The bridge table SHALL NOT be the only ledger. Every entry by which a request can acquire (or be denied) an identity SHALL be recorded in the same requirement, because a door that is not written down is a door nobody audits:

**Auth-exempt prefixes.** A path prefix the gate skips wholesale SHALL be listed with its own credential mechanism and its failure posture. A prefix SHALL authenticate itself before the route reads or returns data; the only prefix that MAY carry no credential is one that serves no data at all (a public asset). A prefix that neither authenticates itself nor is data-free SHALL be gated instead of exempted. The list, as implemented (`AUTH_EXEMPT_PREFIXES` in `server/auth.js`):

| Prefix | Its own credential | Fail posture |
| --- | --- | --- |
| `/chart-assets/` | none — static chart-rendering library, no data | always public |
| `/api/bots/webhook/` | per-bot path secret + the chat platform's signature/decryption | identical refusal for unknown/disabled/bad secret |
| `/api/bots/relay/` | bearer (`BOT` relay token) | 401 |
| `/api/mp/login`, `/api/mp/login-bindcode` | the platform's own `wx.login` code2session exchange (+ bind code) | 503 when MP credentials absent |
| `/api/app/pair`, `/api/app/challenge`, `/api/app/login` | device pairing bind code / device-key challenge signature | 503 when no token secret |
| `/api/ops/` | bearer (`PACK_USAGE_TOKEN`) | 503 unconfigured, 401 wrong |
| `/local-registry/` | bearer (`WANXING_LOCAL_FEED_TOKEN`); loopback-only when never minted | 401 |
| `/api/trial-exec` | `x-facet-token` (internal service credential) | 401 |

**Identity doors.** Every way an identity enters, or a request is admitted without one, SHALL be listed with its credential, the condition under which it counts, and what happens when it fails:

| Door | Credential | Counts when | On failure |
| --- | --- | --- | --- |
| Proxied identity headers (`x-forwarded-email`/`-groups`/`-roles`/`-role-admin`/`-layout`) | gateway secret (`x-cloud-gateway-secret`, constant-time) | hosted mode sets a secret | headers treated as absent entirely |
| Identity-provider session cookie | provider-signed cookie | `AUTH_MODE=logto` | 401 (`/api/`) or redirect (`html`) |
| Mini-program bearer | platform-issued token, verified server-side | MP credentials configured | identity is null |
| Paired device bearer | device key / bind code | device-auth credentials configured | identity is null |
| Internal bridges (the table above) | loopback AND no `x-forwarded-email` | always | falls through to the normal gate |
| Auth disabled | none — the machine owner | auth explicitly off | admin/manage gates admit everyone (documented, never implicit in hosted mode) |
| Cell-owner MCP management | `req.user.email` equals the cell's owner email | hosted cell | 403 |
| Admin gate | admin group membership or the role-admin claim | auth enabled | 403 |
| Business roles (`x-forwarded-roles`) | the same gateway secret as the identity pair | hosted mode | header ignored |
| Deployment layout (`x-forwarded-layout`) | the same gateway secret | hosted mode | malformed value degrades to "no header" |

A shared secret SHALL be compared through one constant-time implementation; a route that re-implements the comparison inline SHALL be treated as drift. Adding, widening, or exempting any entry above SHALL be treated as widening the trust boundary, and the change SHALL update this requirement in the same landing.

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

#### Scenario: an exempt prefix authenticates itself

- **WHEN** a path prefix is skipped by the auth gate
- **THEN** the route behind it SHALL verify its own credential before reading or returning data, or the prefix SHALL serve no data at all
- **AND** a prefix with no credential that answers with data SHALL be treated as a defect, not a posture
- **AND** the prefix SHALL be listed in this requirement's table with its mechanism and failure posture

#### Scenario: shared secrets compare in constant time

- **WHEN** any route compares a caller-supplied shared secret against configuration
- **THEN** the comparison SHALL go through the single constant-time implementation
- **AND** a route comparing with an ordinary equality operator SHALL be treated as drift and fixed

#### Scenario: the ledger and the code agree

- **WHEN** a new auth-exempt prefix or identity door is added to the code
- **THEN** the corresponding table in this requirement SHALL be updated in the same landing
- **AND** a check SHALL fail when the implemented prefix set and the documented set diverge
