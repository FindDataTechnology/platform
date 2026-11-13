# pack-marketplace Specification (Delta)

## ADDED Requirements

### Requirement: Claude marketplace manifest endpoint

The facet service SHALL serve a public, unauthenticated endpoint in the Claude Code plugin-marketplace format (`.claude-plugin/marketplace.json` semantics) that lists public curated packs as installable plugin entries. Each entry SHALL expose the pack's skills as plugin skill content fetchable without an account; MCP references SHALL appear as connection guidance (endpoint and credential notice) only, and SHALL NOT be embedded as server configuration in the plugin body. Private and unlisted packs SHALL be absent. The endpoint SHALL reflect the current listing state on refresh, with cache headers no longer than one hour.

#### Scenario: One command adds the marketplace

- **WHEN** a Claude Code user runs the plugin-marketplace add command against the facet endpoint
- **THEN** the marketplace is added and its packs are browsable and installable as plugins

#### Scenario: MCP stays guidance, never embedded server config

- **WHEN** a listed pack declares MCP references and its plugin entry is inspected
- **THEN** the entry carries connection guidance naming the endpoint and credential requirement, and no MCP server configuration

#### Scenario: Non-public packs never appear

- **WHEN** the endpoint response is fetched by an anonymous visitor
- **THEN** private and unlisted packs are absent from the listing, matching the browse surface's public set
