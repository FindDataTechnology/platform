# extension-marketplace Specification

## Purpose
The in-app market for MCP servers and skills: a curated catalog (bundled `market-catalog*.json` plus, when configured, a remote mcp-gateway-registry) browsable by category with a derived `requiresConfig` flag, one-click install that routes MCP entries through the template-generated setup form, at least three zero-config MCP servers shipped, registry entries filtered per user by group membership with that admission re-enforced server-side on the install path, and registry skill content fetched at install time into the existing custom-skill path.

## Requirements

### Requirement: Market catalog is browsable
The UI SHALL present a market tab displaying a curated catalog of MCP servers and skills, organized by category (e.g., productivity, development, data, communication). Each MCP catalog entry SHALL carry a derived `requiresConfig` flag indicating whether the server needs user-supplied configuration (a secret or path) before it can connect. Entries with `requiresConfig === false` ("ready to use") SHALL be ordered before entries with `requiresConfig === true` ("needs config"), so servers usable out of the box surface first.

#### Scenario: user browses market catalog
- **WHEN** user navigates to the market tab
- **THEN** the UI SHALL display a list of available MCP servers and skills
- **AND** each item SHALL show name, description, category, and an "Install" button
- **AND** items SHALL be filterable by category

#### Scenario: user searches market
- **WHEN** user types in a search box
- **THEN** the UI SHALL filter the catalog to items matching the search query

#### Scenario: ready-to-use servers are ordered first
- **WHEN** the market catalog is rendered
- **THEN** every MCP server with `requiresConfig === false` SHALL appear before any server with `requiresConfig === true`
- **AND** within each group entries SHALL be ordered by name

#### Scenario: each MCP card shows a config-requirement badge
- **WHEN** an MCP market card is rendered
- **THEN** the card SHALL display a badge derived from the entry's `requiresConfig` flag
- **AND** a `requiresConfig === false` entry SHALL show a "ready to use" badge
- **AND** a `requiresConfig === true` entry SHALL show a "needs config" badge

### Requirement: One-click install from market
The UI SHALL allow users to install an MCP server or skill from the market. Clicking "Install" on an MCP server SHALL always open the MCP setup form (see the *MCP setup form is generated from config template* requirement in `extension-management-ui`) pre-filled from the catalog template, so the user can confirm or rename before adding. For servers whose `requiresConfig` is `false`, the form has no fillable config fields (only the name), so the Add button is enabled immediately. For servers whose `requiresConfig` is `true`, the form shows labeled fields the user must fill before Add is enabled. Registry-origin entries are credential-shaped instead of token-shaped: their install form SHALL show no fillable credential field when the user holds a live registry credential (see the `registry-credentials` capability), and SHALL route to the connect flow (or manual paste fallback) when they do not.

#### Scenario: user installs a ready-to-use MCP server from market
- **WHEN** user clicks "Install" on an MCP server whose `requiresConfig` is `false`
- **THEN** the system SHALL open the MCP setup form pre-filled from the entry's `configTemplate`
- **AND** the form SHALL show no fillable config fields (only the prefilled name)
- **AND** the Add button SHALL be enabled immediately
- **WHEN** the user clicks Add
- **THEN** the server SHALL be added from the template and SHALL appear in the "Installed" tab

#### Scenario: user installs a needs-config MCP server from market
- **WHEN** user clicks "Install" on an MCP server whose `requiresConfig` is `true`
- **THEN** the system SHALL open the MCP setup form pre-filled from the entry's `configTemplate`
- **AND** SHALL NOT add the server until the user fills the required fields and confirms
- **AND** after the user submits valid values, the server SHALL appear in the "Installed" tab

#### Scenario: user installs a registry MCP with a live credential

- **WHEN** a user with a live registry credential clicks "Install" on a registry-origin MCP entry
- **THEN** the setup form SHALL show no fillable credential field and the Add button SHALL be enabled immediately
- **AND** the installed record SHALL reference the registry credential rather than embedding a secret

#### Scenario: user installs a registry MCP without a credential

- **WHEN** a user without a live registry credential clicks "Install" on a registry-origin MCP entry
- **THEN** the UI SHALL offer the connect flow and the manual paste fallback
- **AND** Add SHALL remain disabled until a credential exists

#### Scenario: user installs skill from market
- **WHEN** user clicks "Install" on a skill in the market
- **THEN** the system SHALL create the skill definition in the skills store from the template
- **AND** the skill SHALL appear in the "Installed" tab
- **AND** the skill SHALL be available for invocation

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

### Requirement: Registry market entries are group-scoped per user
`GET /api/extensions/market` SHALL filter registry-sourced entries by group: an entry carrying a non-empty group list SHALL be included only when the requesting user's groups intersect it. Registry entries with empty or absent group metadata SHALL be visible to everyone. Bundled entries SHALL always be visible regardless of the user. When authentication is off, the requester is the machine owner: all entries, gated or not, SHALL be visible — matching the auth-off semantics of administrator gating elsewhere in the platform (a deployment with no identities has no one to exclude).

#### Scenario: group member sees gated entry
- **WHEN** a registry MCP entry lists groups `["mcp-jira-users"]` and the requesting user's groups include `mcp-jira-users`
- **THEN** the market response SHALL include that entry

#### Scenario: non-member does not see gated entry
- **WHEN** a registry MCP entry lists groups `["mcp-jira-users"]` and the requesting user's groups do not include it
- **THEN** the market response SHALL omit that entry

#### Scenario: bundled entries unaffected by auth mode
- **WHEN** auth is off or the user belongs to no registry groups
- **THEN** bundled catalog entries SHALL still appear in the market response

#### Scenario: auth-off requester sees gated entries
- **WHEN** authentication is off and the registry supplies an entry with groups `["mcp-jira-users"]`
- **THEN** the market response SHALL include that entry, because the requester is the machine owner

### Requirement: Registry skill content is fetched at install time
The market SHALL list registry skills by metadata only. When the user installs a registry skill, the server SHALL fetch the skill's content from the registry (`GET /api/skills/{path}/content` with the service token) and create the custom skill through the existing market-install path, so it appears in the Installed tab and becomes invokable without a restart. If the content fetch fails, the install SHALL fail with an error naming the skill and no partial skill SHALL be created.

#### Scenario: registry skill installs with live content
- **WHEN** the user clicks Install on a registry-sourced skill
- **THEN** the server fetches the current content from the registry and creates the skill
- **AND** the skill appears in the Installed tab and is available for invocation

#### Scenario: content fetch failure surfaces an error
- **WHEN** the registry content fetch fails for a skill being installed
- **THEN** the install SHALL return an error to the client and no skill SHALL be created

### Requirement: 目录条目按 locale 渲染供给注释

MCP 市场目录条目 SHALL 在条目携带供给注释时按请求 locale 渲染 human 通俗名与一句话说明（解析优先级与 zh 唯一回落沿 `supply-annotation-overlay`）；未注释条目 SHALL 保持现有渲染（上游原文）逐字节不变。目录读取 MUST NOT 因注释投影产生任何源写操作。

#### Scenario: 双语条目按 locale 呈现

- **WHEN** 以 `locale=en` 与 `locale=zh` 分别读取同一台带 zh+en 注释的市场条目
- **THEN** 两请求分别呈现英文名与中文名，描述同规则

#### Scenario: 未注释条目逐字节不变

- **WHEN** 以任意 locale 读取一台无注释的市场条目
- **THEN** 响应显示字段与未引入注释层前逐字节一致

### Requirement: Market installs enforce group admission
Installing a market entry that carries groups SHALL require the requesting user's groups to intersect the entry's groups. This admission SHALL be enforced server-side on the install path for both MCP servers and registry skills — market visibility filtering alone SHALL NOT be the only barrier (a hidden entry could still be installed by calling the API directly with a guessed name). A successful gated MCP install SHALL persist the entry's groups on the installed record as `requiredGroups` so runtime filtering can act on it after installation. Ungated entries (no groups) install exactly as before and SHALL NOT carry `requiredGroups`.

#### Scenario: role holder installs gated MCP entry
- **WHEN** a user whose groups include `mcp-jira-users` installs a market MCP entry carrying groups `["mcp-jira-users"]`
- **THEN** the install SHALL succeed
- **AND** the installed record SHALL carry `requiredGroups: ["mcp-jira-users"]`

#### Scenario: non-member install is rejected
- **WHEN** a user whose groups do not include `mcp-jira-users` submits an MCP install whose name matches a market entry carrying groups `["mcp-jira-users"]`, bypassing the market listing
- **THEN** the server SHALL reject the request with an authorization error
- **AND** no MCP record SHALL be created

#### Scenario: registry skill install enforces the same admission
- **WHEN** a user without a matching group installs a registry skill whose entry carries groups
- **THEN** the install SHALL be rejected with an authorization error
- **AND** no skill SHALL be created

#### Scenario: auth-off install is unrestricted
- **WHEN** authentication is off and a market entry carries groups
- **THEN** the install SHALL succeed
- **AND** the installed record SHALL carry the entry's groups as `requiredGroups`
