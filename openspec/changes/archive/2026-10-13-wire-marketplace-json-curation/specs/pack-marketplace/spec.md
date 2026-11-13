## MODIFIED Requirements

### Requirement: Claude marketplace manifest endpoint

The facet service SHALL serve a public, unauthenticated endpoint in the Claude Code plugin-marketplace format (`.claude-plugin/marketplace.json` semantics) that lists public curated packs as installable plugin entries. **Curated SHALL mean the pack carries a non-empty `category` or a true `featured` flag — the same curation signals the browse face consumes** — unless the operator whitelist (`FACET_MARKETPLACE_PACK_IDS`) is set, in which case the whitelist alone defines the listing (override semantics, applied instead of — not intersected with — the curation filter). Each entry SHALL expose the pack's skills as plugin skill content fetchable without an account; MCP references SHALL appear as connection guidance (endpoint and credential notice) only, and SHALL NOT be embedded as server configuration in the plugin body. Private and unlisted packs SHALL be absent. Uncurated public packs SHALL be absent from the listing while their plugin tree files remain fetchable by direct version URL (listing governs discovery, not access). The endpoint SHALL reflect the current listing state on refresh, with cache headers no longer than one hour.

#### Scenario: One command adds the marketplace

- **WHEN** a Claude Code user runs the plugin-marketplace add command against the facet endpoint
- **THEN** the marketplace is added and its curated packs are browsable and installable as plugins

#### Scenario: MCP stays guidance, never embedded server config

- **WHEN** a listed pack declares MCP server references
- **THEN** the plugin README SHALL carry connection guidance (endpoint and credential notice) only
- **AND** the plugin body SHALL NOT embed server configuration

#### Scenario: Non-public packs never appear

- **WHEN** a pack is private or unlisted
- **THEN** it SHALL be absent from the listing and its plugin tree files SHALL return not-found

#### Scenario: Uncurated public packs stay off the listing

- **WHEN** a public non-unlisted pack has an empty `category` and a false `featured` flag and no operator whitelist is set
- **THEN** the marketplace listing SHALL omit the pack
- **AND** its plugin tree files SHALL remain fetchable by direct version URL

#### Scenario: Operator whitelist overrides curation

- **WHEN** `FACET_MARKETPLACE_PACK_IDS` is set to a comma-separated list of pack ids
- **THEN** the listing SHALL contain exactly those packs that are public and non-unlisted
- **AND** packs on the whitelist SHALL be listed even without a category or featured flag
- **AND** the curation filter SHALL NOT further narrow the whitelist
