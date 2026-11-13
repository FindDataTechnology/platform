# extension-management-ui Delta

## MODIFIED Requirements

### Requirement: Installed / Market tabs preserved

The MCP and Skills management panes SHALL present two sub-tabs — **Installed（已启用）** and **Market（商店）** — preserving the existing add/edit/remove/toggle behavior on the Installed tab. The former third tab（外部源）is merged into the Market tab as its external zone (per `external-skill-sources`).

The Market tab SHALL be a pure shelf: it SHALL present browsable catalog content only and SHALL NOT host credential connect cards — the connect cards that previously rendered at the top of the market tab live in the Settings connections section (per `connection-center`).

Deep links SHALL keep resolving: `/settings/mcp?tab=market` and `/settings/skills?tab=market` SHALL open the Market tab of the corresponding sub-view; `?tab=external` SHALL resolve into the Market tab's external zone in the skills sub-view (and to the Market tab itself in the tools sub-view, where no external zone exists).

#### Scenario: sub-tabs still work at new route

- **WHEN** the user visits `/settings/mcp`
- **THEN** the MCP management pane SHALL render with the Installed / Market sub-tabs
- **AND** selecting Market SHALL show the pure market shelf without any connect cards

#### Scenario: market deep links keep resolving

- **WHEN** the user opens `/settings/mcp?tab=market` (e.g. the line-mint round-trip return URL)
- **THEN** the Market tab SHALL be active and render the shelf

#### Scenario: external deep link resolves into the market zone

- **WHEN** the user opens `/settings/skills?tab=external`
- **THEN** the Market tab SHALL be active with its external zone prominent

## ADDED Requirements

### Requirement: Market tab presents catalog and external zones

The Market tab SHALL organize its content into two labeled zones: **市场目录**（the platform catalog of MCP servers / skills）and **外部市场**（the external skill shelf carrying the "not reviewed by this platform" posture, per `external-skill-sources`). The external zone SHALL appear only in the skills sub-view; the tools (mcp) sub-view SHALL NOT render the external zone — the tools sub-view's market tab SHALL present the catalog zone only.

#### Scenario: skills sub-view shows both zones

- **WHEN** the user opens the Market tab in the skills sub-view
- **THEN** both the catalog zone and the external zone render, with the external zone's unreviewed posture visible

#### Scenario: tools sub-view shows catalog only

- **WHEN** the user opens the Market tab in the tools (mcp) sub-view
- **THEN** only the catalog zone renders and no external-market zone is present
