# project-identity 身份面回写

## MODIFIED Requirements

### Requirement: Machine-facing client identifiers use the product name

Machine-facing identifiers SHALL carry the product name as a PREFIX, scoped to
the component that speaks (`platform-<component>`), rather than one bare
`platform` string: several distinct components open MCP sessions and fetch
third-party URLs, so a single shared name would erase which one is speaking.
The prefix is `platform` — never a repository codename or a romanized brand
variant — for every component touched from now on. Two historical prefixes
remain in service on surfaces that have not been revisited: `paas-` (the
repository's internal name: `paas-chart-refresh`, `paas-connector-paste`,
`paas-publish-tool-gate`) and `yizuo-` (the Chinese brand's romanization:
`yizuo-external-skill-sources/1.0`). Those SHALL be normalized to `platform-*`
when their surface is next modified; until then they are recorded deviations,
not precedents. Renaming them is an outward-facing change (third-party servers
log and may allowlist these identifiers) and therefore needs its own decision
rather than riding an unrelated edit.

#### Scenario: MCP client identifies as platform

- **WHEN** a component connects to an MCP server
- **THEN** the client info `name` reported in the MCP handshake SHALL begin with `platform-` (for example `platform-mcp-preflight`)
- **AND** it SHALL NOT be a bare `platform` string, which would make distinct components indistinguishable in the server's log

#### Scenario: knowledge fetch User-Agent

- **WHEN** the platform fetches a URL on a user's behalf — document ingestion (`platform-documents/1.0`) or external skill-source discovery (`yizuo-external-skill-sources/1.0`, a recorded deviation pending normalization)
- **THEN** the request's `User-Agent` SHALL identify the platform by name and version
- **AND** SHALL NOT be empty or a generic library default

### Requirement: Startup log uses the product name

The server startup log line SHALL begin with the product name and report the
address it is bound to, so an operator scanning logs can tell which product
came up and where.

#### Scenario: server starts

- **WHEN** the server starts and logs its bind address
- **THEN** the line SHALL begin with `Platform ` and carry `http://<HOST>:<PORT>`
- **AND** it SHALL state whether agent initialization is still running in the background (the current line reads `Platform listening at http://<HOST>:<PORT> (agent init in background)`)
