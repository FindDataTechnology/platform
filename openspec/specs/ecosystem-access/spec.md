# ecosystem-access Specification

## Purpose
外部开发者进入谦面的身份面：自助注册即得 community 身份与调用键，默认可见面是只读公开数据 server，付费档 server 以组边界区分——身份、免费额度与付费墙在这里收口。

**实现权威在外部仓。** 本能力管辖的面——开放注册、调用键签发/吊销（`wgk-`）、组到 scope 的映射、community/付费档的 server 划分、网关的 MCP 代理——实现与部署都在注册表服务，不在本仓：gitee `FindDataTechnology/mcp-gateway-registry`（OSS `agentic-community/mcp-gateway-registry` 的 fork），以 docker compose 栈运行在网关 `mcp.finddatatech.cloud` 之后（部署与版本钉见 `docs/registry-maintenance.md`）。本 spec 是跨仓契约真源；paas 仓只有消费端缝（registry 客户端 env、facet 桥、市场侧的 registry 读）。这里的场景按**已部署的注册表**验收，paas 单仓测试证明不了它。


## Requirements

### Requirement: Self-service signup grants community identity and a mintable caller key

The identity provider SHALL accept open self-service registration. A registered user SHALL land in the community group and be able to mint a long-lived caller key (wgk-) for machine use, within the per-user active-key limit, through a self-service mint surface (web console, and the CLI connect flow per facet-editor-cli). The key carries the community group's scopes; revocation is self-service and immediate.

#### Scenario: Signup to working key with no operator step

- **WHEN** an external developer registers, verifies, and mints a caller key
- **THEN** the key authenticates on the registry gateway's MCP proxy paths with community scopes, with no operator involvement

#### Scenario: Key revocation is immediate

- **WHEN** the developer revokes their key
- **THEN** subsequent calls with that key are rejected and the owning user's scope set is unaffected for other keys

### Requirement: Community default visibility is read-only public data servers

A community caller key SHALL grant access to exactly the public data servers (fd-open-data-mcp, fd-cn-report) with read-class tool access. Servers assigned to paid tiers — law-bench — SHALL refuse community keys with a machine-readable upgradeable error naming the required tier, and SHALL remain absent from the community key's server listings.

#### Scenario: Community key reads public data

- **WHEN** a community key calls a read tool on fd-open-data-mcp through the gateway
- **THEN** the call is admitted and proxied

#### Scenario: Paid-tier server refuses community keys

- **WHEN** a community key attempts a call to law-bench
- **THEN** the call is refused before upstream with an upgradeable error naming the paid tier, and law-bench does not appear in that key's visible server list

### Requirement: Paid tier unlocks gated servers by group assignment

Upgrading an external user to a paid tier SHALL be expressible as assigning the user to the paid tier's group; the user's existing keys then carry the widened scopes without re-minting. Downgrade reverses visibility on the same mechanism.

#### Scenario: Upgrade widens an existing key

- **WHEN** a community user is assigned to the paid tier group
- **THEN** their existing caller key's next gateway call sees the gated servers, with no key re-mint required

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
