# mcp-auth-lanes Specification

## Purpose
MCP 连接的三条鉴权车道（无凭据/共享池/用户凭据）的能力表与证据纪律：每车道声明支持的能力组合，stale 凭据的降级口径，refresh token 语义。实现锚点在 facet/cli/mcp-auth-capability.js 与连接面板。

## Requirements

### Requirement: Three connection lanes with automatic selection by evidence

The system SHALL support three connection lanes for reaching the gateway's MCP servers from any client, and SHALL select the lane per target from a machine-verified capability table rather than from documentation or manual judgment:

- **L1 native OAuth** — the client is given a pre-registered static OAuth client identifier and performs the authorization flow itself; no credential is written into any configuration file.
- **L2 brokered token** — the CLI performs the authorization flow and writes a short-lived access token into the target's static `Authorization` header, so that a client which does not implement OAuth can still connect without the user handling any key string.
- **L3 caller key** — the device-flow `wgk-` key established by the connect flow, retained for headless, scripted, and enterprise-internal use.

Lane selection SHALL prefer L1 where the capability table records that the client consumes a static client identifier; SHALL fall back to L2 where the client supports static headers but does not consume a client identifier; and SHALL use L3 only where neither is available or where no browser can be opened. The CLI SHALL state which lane it used and why.

#### Scenario: A client that ignores the OAuth block gets a brokered token

- **WHEN** the target client's capability record says it does not consume a static client identifier from its configuration file, but it does send static headers
- **THEN** the CLI selects L2 and writes a short-lived bearer token into the target's static header
- **AND** the user performs one browser authorization and never sees or copies a key string

#### Scenario: A client that honours a static client identifier is preferred

- **WHEN** the target client's capability record says it consumes a static client identifier
- **THEN** the CLI selects L1 and writes only the client identifier and scope, with no secret in the file

#### Scenario: Lane choice is never silent

- **WHEN** the CLI writes or refuses to write MCP connection configuration
- **THEN** it names the lane it selected and the reason, so a user can tell a client-side limitation from a server-side failure

### Requirement: Capability records carry only machine evidence

The capability table SHALL record, per client and per version range, three facts: whether a static `Authorization` header is honoured, whether a configuration-file OAuth client identifier reaches the client's MCP SDK auth provider, and whether the client supports dynamic client registration. Every record SHALL carry evidence naming the probe that produced it, the time it was taken, and the client build it was taken against. A record SHALL NOT be based on vendor documentation alone, and a record without evidence SHALL be treated as absent.

When a client's version changes such that its recorded evidence no longer matches the installed build, the record SHALL be marked stale; a stale record SHALL NOT be used to select L1, and the CLI SHALL fall back to L2 while telling the user that the client's new version awaits re-verification.

#### Scenario: Stale evidence demotes to the fallback lane

- **WHEN** the installed client build does not match the build named in its capability record's evidence
- **THEN** the CLI treats the record as stale, selects L2, and reports that the newer client version needs re-verification

#### Scenario: An unevidenced claim cannot select a lane

- **WHEN** a client has no capability record, or its record lacks evidence
- **THEN** the CLI does not claim the native OAuth lane works for it, and either uses L2 or refuses with an explanation

### Requirement: A client counts as solved only when no key is ever shown and expiry is not a chore

A client SHALL be counted as solved for keyless access only when all of the following hold: the distributed pack carries no credential-shaped string; the user reaches the data plane without seeing or copying any key string; an expired token is recovered without the user repeating a full authorization; a refused call is diagnosed as expired, group-mismatched, or disabled rather than as a bare 401; and the capability record for that client build cites machine evidence.

Expiry recovery SHALL be provided for L2 and L3 by a refresh action that renews silently where a refresh token is available and otherwise re-authorizes in one step.

#### Scenario: Expired token is recovered without a full re-authorization

- **WHEN** an L2 token has expired and the authorization server has issued a refresh token
- **THEN** the refresh action renews the token and rewrites the target's configuration without a browser interaction

#### Scenario: Refusal is classified

- **WHEN** a connection attempt is refused after a lane was configured
- **THEN** the diagnosis distinguishes an expired or revoked token, a missing group or role, and a disabled server

### Requirement: Authorization requests obtain a refresh token

The CLI's authorization flow SHALL request offline access and SHALL force a consent interaction on the authorization request, so that the authorization server issues a refresh token; the OAuth application used by the CLI SHALL have refresh token rotation enabled. A flow that returns an access token without a refresh token while the target lane depends on renewal SHALL be treated as a defect, not as an acceptable outcome.

#### Scenario: Refresh token is present after the flow

- **WHEN** the CLI completes its authorization flow against the production authorization server
- **THEN** the token response carries a refresh token, and the CLI reports the renewability of the stored credential

#### Scenario: Missing refresh token is surfaced as a defect

- **WHEN** the token response carries no refresh token
- **THEN** the CLI reports that silent renewal is unavailable and names it as a configuration defect rather than silently degrading to repeated manual authorization
