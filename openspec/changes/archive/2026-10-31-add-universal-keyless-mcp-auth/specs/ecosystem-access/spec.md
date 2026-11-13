## MODIFIED Requirements

### Requirement: Native OAuth discovery connection is supported

The registry gateway SHALL support MCP-spec authorization discovery for external harness clients: an unauthenticated MCP request SHALL be refused with a `WWW-Authenticate` header pointing at the protected-resource metadata; the registry SHALL serve the RFC 9728 protected-resource document and the authorization-server metadata document; and the discovery documents SHALL be served without cacheability (no-store).

The gateway SHALL accept a connection completed with a **pre-registered static client identifier** and SHALL NOT require the authorization server to expose a dynamic client registration endpoint. Dynamic client registration is a MAY in the MCP specification and is deprecated as of its 2026-07-28 revision; requiring it would make an unimplemented, deprecated capability a precondition for connecting.

The gateway SHALL accept the resource identifier it advertises in its own protected-resource document as a bearer token audience, so that a client which sends the advertised resource verbatim as an RFC 8707 resource indicator receives a token the gateway will honour.

#### Scenario: A harness connects with zero manual token entry

- **WHEN** a CC (or equivalent MCP client) user adds the gateway MCP endpoint directly and completes the native OAuth flow in the browser
- **THEN** the connection is established and the caller's visible servers match their group scopes, with no manual key copy-paste

#### Scenario: A pre-registered static client connects without dynamic registration

- **WHEN** a client presents a pre-registered static client identifier and completes the authorization-code flow with PKCE against the gateway's advertised resource
- **THEN** the issued token's audience is the advertised resource identifier, the gateway accepts it, and an `initialize` followed by `tools/list` succeeds without any dynamic registration request being made

#### Scenario: Absent dynamic registration is not a connection failure

- **WHEN** the authorization server metadata carries no registration endpoint
- **THEN** a client that has a pre-registered static client identifier still connects, and the gateway does not treat the absence as an error condition

#### Scenario: Discovery metadata is not cacheable

- **WHEN** the protected-resource or authorization-server metadata document is fetched
- **THEN** the response carries no-store cache headers so a poisoned cache cannot redirect clients to an attacker-controlled authorization server
