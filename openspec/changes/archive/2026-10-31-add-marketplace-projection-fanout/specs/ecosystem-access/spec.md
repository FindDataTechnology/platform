## ADDED Requirements

### Requirement: Public MCP servers project to the official MCP Registry format

The facet service SHALL be able to project its publicly visible MCP servers into the official MCP Registry `server.json` format (schema `2025-12-11`), so that the servers can be published to the community MCP Registry with the `mcp-publisher` CLI.

Admission SHALL be the same visibility rule the MCP catalog face already applies: a server with no required groups is public and projectable; a server that requires any group SHALL be absent from every projection. The projection SHALL reuse that single rule rather than restate it.

Each projected document SHALL carry the required fields `name` (reverse-DNS form, exactly one `/`, namespace `io.github.FindDataTechnology/<server>`), `description`, and `version`, plus at least one `remotes[]` entry whose `type` is `streamable-http` or `sse` and whose `url` is the server's public MCP endpoint. A document missing a required field, carrying a malformed name, or carrying no remote SHALL be a generation failure for that server, and the remaining servers SHALL still be projected.

The projection SHALL be read-only with respect to registry state and SHALL reflect publish/unpublish and visibility changes within one refresh cycle.

#### Scenario: Public server projects a valid server.json

- **WHEN** a registry MCP server is enabled, has no required groups, and exposes an MCP endpoint
- **THEN** the projection yields a document with `name` `io.github.FindDataTechnology/<server>`, a non-empty `description`, a `version`, and a `remotes[]` entry of type `streamable-http` pointing at that endpoint
- **AND** the document validates against the registry `2025-12-11` schema

#### Scenario: Group-gated server never appears

- **WHEN** a registry MCP server requires any group
- **THEN** it is absent from the projection, matching its absence from the public MCP catalog

#### Scenario: A malformed entry does not poison the batch

- **WHEN** one server lacks a description or endpoint
- **THEN** that server is skipped with a reported reason
- **AND** every other public server is still projected

### Requirement: Projection output never carries credential material

Market projection output SHALL contain no credential material. No projected file (MCP Registry `server.json`, marketplace manifests, or plugin bodies) SHALL embed a real token, key, or secret. Remote entries SHALL point at the keyless endpoint and SHALL carry no `headers` block at all — a keyless endpoint authorizes through OAuth discovery, so a static header (even a placeholder one) would install broken on a client that has no credential.

A generator SHALL refuse rather than sanitize when a credential-shaped string is detected in its output, because a match indicates an upstream publish-gate defect rather than something to strip quietly.

#### Scenario: Key-shaped string blocks the projection

- **WHEN** projected content contains a string matching a known credential shape (e.g. a `wgk-`/`sk-` prefixed secret)
- **THEN** generation refuses and writes nothing
- **AND** the previously published output remains intact

#### Scenario: Remote points at the keyless endpoint

- **WHEN** a public server is projected
- **THEN** the `remotes[]` entry points at the server's public endpoint with no embedded secret
- **AND** the `remotes[]` entry carries no `headers` block

### Requirement: Public distribution repositories are indexable by third-party skill markets

Public facet content SHALL be published in the standard shapes that third-party skill and plugin markets index automatically: skills as `SKILL.md` files within skill directories, and a marketplace manifest at `.codebuddy-plugin/marketplace.json` (or `.claude-plugin/marketplace.json`). Because these markets index public GitHub repositories by their standard layout, ensuring that layout and registering the repository address SHALL be the only work required to be discoverable; no per-market adapter code SHALL be needed.

The public repository used for this purpose SHALL remain free of credential material, consistent with the projection credential rule.

#### Scenario: Skills are discoverable without a custom adapter

- **WHEN** the public distribution repository carries skill directories each with a `SKILL.md` and a `.codebuddy-plugin/marketplace.json` manifest
- **THEN** a third-party skill market that indexes public repositories can list and install those skills by repository address
- **AND** no facet-side code specific to that market is required

#### Scenario: Registered address resolves to installable content

- **WHEN** the repository address is registered with a third-party market
- **THEN** installing an entry from that market materializes the `SKILL.md` files locally

## MODIFIED Requirements

### Requirement: Native OAuth discovery connection is supported

The registry gateway SHALL support MCP-spec authorization discovery for external harness clients: an unauthenticated MCP request SHALL be refused with a WWW-Authenticate header pointing at the protected-resource metadata; the registry SHALL serve the RFC 9728 protected-resource document and the authorization-server metadata document; and the authorization-server document SHALL expose a registration endpoint so a harness client can complete dynamic client registration and connect without manual token entry. The discovery documents SHALL be served without cacheability (no-store).

The gateway SHALL accept a connection completed with a **pre-registered static client identifier** and SHALL NOT require the authorization server to expose a dynamic client registration endpoint. Dynamic client registration is a MAY in the MCP specification and is deprecated as of its 2026-07-28 revision; requiring it would make an unimplemented, deprecated capability a precondition for connecting.

The gateway SHALL accept the resource identifier it advertises in its own protected-resource document as a bearer token audience, so that a client which sends the advertised resource verbatim as an RFC 8707 resource indicator receives a token the gateway will honour.

In addition, the federation-facing connection surface SHALL expose each public MCP server through a Registry `server.json` that names the same native OAuth-capable endpoint, so that a client discovering the server through the MCP Registry can reach the zero-key connection lane. This SHALL NOT change the existing OAuth discovery metadata behavior.

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

#### Scenario: Registry discovery leads to the zero-key lane

- **WHEN** a client discovers a facet MCP server via the MCP Registry listing
- **THEN** the listed remote endpoint is the same native OAuth-capable endpoint the discovery metadata advertises
- **AND** the client can connect with zero manual token entry per the existing OAuth scenario
