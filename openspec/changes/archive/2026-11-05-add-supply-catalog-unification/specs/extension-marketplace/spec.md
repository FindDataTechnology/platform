## RENAMED Requirements

### Requirement: Market catalog is sourced from static JSON or remote registry

- FROM: `Market catalog is sourced from static JSON or remote registry`
- TO: `Market catalog is sourced from the unified supply catalog`

### Requirement: Market catalog includes zero-config MCP servers

- FROM: `Market catalog includes zero-config MCP servers`
- TO: `The market keeps its app-bundled starter floor`

## MODIFIED Requirements

### Requirement: Market catalog is sourced from static JSON or remote registry

The market catalog SHALL be loaded from the unified supply catalog projection (openspec: supply-catalog) served by the facet catalog API family, configured via `FACET_CATALOG_URL` (plus optional `FACET_CATALOG_TOKEN` for non-anonymous reads). The server SHALL fetch the projection server-side, cache it, and re-fetch on a TTL (`MARKET_REGISTRY_TTL_SECS` semantics preserved, default 300) via background refresh using the same token; when the refreshed content changes, the server SHALL broadcast a `market_changed` event over WebSocket. When the catalog fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning.

The hand-curated bundled catalog copy SHALL NOT exist: the bundled `market-catalog.json` / `market-catalog-skills.json` SHALL be generated offline snapshots of the unified catalog (as-of stamped), served only when no catalog source is configured. For the catalog species — remote MCP servers and skills — no merge or collision rule SHALL apply: with a source configured, the online projection is the single truth for those species.

The app-shipped stdio starter servers (a URL-fetch server, a time/date server, and a demo/test server) are product assets, not catalog entries: the market SHALL always append them, online or offline. They carry distinct names that never collide with catalog entries, and their presence SHALL NOT be read as a curation layer.

The legacy `MARKET_REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` direct-registry feed SHALL continue to work during a deprecation window while logging a deprecation warning, and SHALL NOT be combined with `FACET_CATALOG_URL` (the latter wins and a warning names the ignored variable). Registry MCP entries SHALL map to a `configTemplate` of `{ url: <gateway endpoint>, headers: { Authorization: "Bearer <your_token>" } }` so the existing `requiresConfig` derivation classifies them as needing user config.

#### Scenario: remote market catalog

- **WHEN** `FACET_CATALOG_URL` is configured
- **THEN** the market's catalog species SHALL be the unified supply catalog projection, fetched server-side and cached, with no locally merged or overridden catalog entries

#### Scenario: catalog change propagates to clients

- **WHEN** a catalog refresh produces a changed catalog
- **THEN** connected WebSocket clients SHALL receive a `market_changed` event and a subsequent `GET /api/extensions/market` reflects the change

#### Scenario: registry outage keeps last-good entries

- **WHEN** the configured catalog becomes unreachable after a successful fetch
- **THEN** the market SHALL keep serving the last-good entries and log a warning

#### Scenario: bundled market catalog

- **WHEN** 壹座 starts with neither `FACET_CATALOG_URL` nor legacy registry variables configured
- **THEN** the market SHALL serve the generated offline snapshot, identical to what the export pipeline produced, with its as-of stamp visible to the operator
- **AND** no registry fetch, cache, or refresh SHALL occur

#### Scenario: registry entries merge with bundled catalog

- **WHEN** a catalog source is configured
- **THEN** no catalog entry from the offline snapshot is overlaid or collided away — the market's catalog species are exactly the source's projection — while the app-shipped starter floor is appended regardless

#### Scenario: legacy registry variables deprecate loudly

- **WHEN** `MARKET_REGISTRY_URL` plus `MARKET_REGISTRY_TOKEN` are configured without `FACET_CATALOG_URL`
- **THEN** the market SHALL load from the legacy registry feed during the deprecation window and every refresh SHALL log a deprecation warning

#### Scenario: both sources configured

- **WHEN** both `FACET_CATALOG_URL` and `MARKET_REGISTRY_URL` are configured
- **THEN** the unified catalog SHALL be used, the legacy variable SHALL be ignored, and a warning SHALL name the ignored variable

### Requirement: Market catalog includes zero-config MCP servers

The served market SHALL include at least three MCP servers that require no user-supplied secret or path to connect (derived `requiresConfig === false`): a URL-fetch server, a time/date server, and a demo/test server. These are app-shipped stdio starters appended to every served market — online projection or generated offline snapshot — and are not catalog entries; their presence SHALL NOT depend on any catalog source being configured or reachable.

#### Scenario: catalog contains multiple ready-to-use MCP servers

- **WHEN** the market catalog is loaded from the generated offline snapshot
- **THEN** at least three MCP entries SHALL have `requiresConfig === false`
- **AND** the set SHALL include a fetch server, a time server, and a demo server distinct from `memory` and `sequential-thinking`

#### Scenario: online market keeps the starter floor

- **WHEN** the market catalog is loaded from the unified catalog projection
- **THEN** the same three stdio starters are appended with `requiresConfig === false`, beside the projection's gateway-sourced entries
