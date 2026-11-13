# extension-management-ui Specification Delta

## MODIFIED Requirements

### Requirement: MCP Servers and Skills are Settings sections

The management surfaces for MCP servers and skills SHALL be the 工具 (`tools`) and 技能 (`skills`) tabs of the 素材市场 surface at `/agents`, and SHALL NOT be Settings sections: the Settings modal SHALL NOT carry an `mcp` or `skills` section, and neither surface SHALL be a sidebar navigation tab.

`/settings/mcp` and `/settings/skills` SHALL each be a route-level redirect to `/agents?tab=tools` and `/agents?tab=skills` respectively (owned by `settings-surface`), never a modal-opening section alias. The legacy paths `/mcp`, `/skills`, `/extensions`, `/extensions/mcp`, and `/extensions/skills` SHALL redirect likewise — `/mcp`, `/extensions`, and `/extensions/mcp` to `/agents?tab=tools`; `/skills` and `/extensions/skills` to `/agents?tab=skills` — so existing deep links and bookmarks continue to resolve rather than 404. The redirect SHALL be a redirect and not an alias: exactly one canonical URL SHALL render each view, and none of these paths SHALL open the Settings modal.

This requirement changes the container only. The MCP and Skills pane components, their controls, their form and dialog behavior, their `?tab=` deep-link contract, and their `data-testid` attributes SHALL be unchanged — they are reused verbatim inside the market tabs. No page body is rewritten by this change.

The two slugs SHALL leave the Settings section definitions and the Settings container of the surface registry together, so the registry↔definitions agreement holds (per `settings-surface`, `layout-configuration`); their markets are work surfaces, not configuration.

#### Scenario: legacy extension paths redirect into Settings

- **WHEN** the user navigates to `/mcp`
- **THEN** the router SHALL redirect to `/agents?tab=tools`
- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/agents?tab=tools`
- **WHEN** the user navigates to `/extensions/mcp`
- **THEN** the router SHALL redirect to `/agents?tab=tools`
- **WHEN** the user navigates to `/skills`
- **THEN** the router SHALL redirect to `/agents?tab=skills`
- **WHEN** the user navigates to `/extensions/skills`
- **THEN** the router SHALL redirect to `/agents?tab=skills`
- **AND** the Settings modal SHALL NOT open on any of these paths

#### Scenario: Settings sections render the management panes

- **WHEN** the user opens `/agents?tab=tools`
- **THEN** the URL SHALL be `/agents?tab=tools`
- **AND** the MCP Servers management pane SHALL render inside the 工具 tab
- **WHEN** the user opens `/agents?tab=skills`
- **THEN** the URL SHALL be `/agents?tab=skills`
- **AND** the Skills management pane SHALL render inside the 技能 tab
- **AND** the Settings modal SHALL offer neither pane as a section

#### Scenario: page internals and test identifiers are unchanged

- **WHEN** the MCP or Skills pane renders inside its market tab
- **THEN** every control, form, dialog, and empty state SHALL behave exactly as it did in the former Settings section
- **AND** every `data-testid` attribute within the pane SHALL retain the value it had before this change

#### Scenario: the page-level heading is dropped as a duplicate

- **WHEN** the MCP or Skills pane renders inside its market tab
- **THEN** it SHALL NOT render a page-level `<h1>` naming the pane
- **AND** the market sub-tab label (工具 / 技能) SHALL be the sole label for it
- **AND** the section heading within the pane body SHALL remain

#### Scenario: MCP and Skills are absent from the sidebar navigation

- **WHEN** the sidebar renders
- **THEN** no "MCP Servers" navigation tab SHALL be present
- **AND** no "Skills" navigation tab SHALL be present
- **AND** both SHALL be reachable only through the 工具 and 技能 tabs of the 素材市场
- **AND** the Settings modal SHALL NOT list them

#### Scenario: deep links and test identifiers survive the move

- **WHEN** the user opens `/agents?tab=tools` or `/agents?tab=skills` directly in a new tab
- **THEN** the corresponding pane SHALL render with the same `data-testid` attributes it carried in the former Settings section
- **AND** a legacy link to the pane's Market sub-view SHALL land on the same view after the redirect, without an error page

### Requirement: Installed / Market tabs preserved

The MCP and Skills management panes SHALL present two sub-tabs — **Installed（已启用）** and **Market（商店）** — preserving the existing add/edit/remove/toggle behavior on the Installed sub-tab, now inside the 工具 (`?tab=tools`) and 技能 (`?tab=skills`) tabs of the 素材市场 surface at `/agents`. The former third tab（外部源）SHALL remain merged into the Market sub-tab as its external zone (per `external-skill-sources`).

The Market sub-tab SHALL remain a pure shelf: it SHALL present browsable catalog content only and SHALL NOT host credential connect cards — the connect cards live in the Settings connections section (per `connection-center`).

Deep links SHALL keep resolving after the container move: `/agents?tab=tools` and `/agents?tab=skills` SHALL open the corresponding pane; the legacy `/settings/mcp?tab=market` and `/settings/skills?tab=market` SHALL redirect to the corresponding market tab with the Market sub-tab active; `?tab=external` SHALL resolve into the skills pane's Market sub-tab with the external zone prominent, and into the tools pane's Market sub-tab itself where no external zone exists. The `/agents` `?tab=` namespace is the five species slugs (per `agent-catalog`) — the pane's Installed / Market sub-view selection SHALL NOT introduce a competing `/agents?tab=` value, and a legacy URL carrying one SHALL be normalized by the redirect rather than erroring.

#### Scenario: sub-tabs still work at new route

- **WHEN** the user visits `/agents?tab=tools`
- **THEN** the MCP management pane SHALL render with the Installed / Market sub-tabs
- **WHEN** the user visits `/agents?tab=skills`
- **THEN** the Skills management pane SHALL render with the Installed / Market sub-tabs
- **AND** selecting Market SHALL show the pure market shelf without any connect cards

#### Scenario: market deep links keep resolving

- **WHEN** the user opens `/agents?tab=tools` (the line-mint round-trip return URL after the move)
- **THEN** the tools pane SHALL be active and render the shelf
- **WHEN** the user follows the pre-move return URL `/settings/mcp?tab=market`
- **THEN** the router SHALL redirect to `/agents?tab=tools` with the Market sub-tab active, and no error SHALL surface

#### Scenario: external deep link resolves into the market zone

- **WHEN** the user opens `/settings/skills?tab=external`
- **THEN** the router SHALL redirect to `/agents?tab=skills`
- **AND** the Market sub-tab SHALL be active with its external zone prominent

### Requirement: dsh plugin bundles are a Settings section

The web UI SHALL render the deployment's dsh plugin catalogue in the 插件 (`plugins`) tab of the 素材市场 surface at `/agents`, and SHALL NOT carry it as a Settings section: `/settings/plugins` SHALL be a route-level redirect to `/agents?tab=plugins` (owned by `settings-surface`), and the sidebar SHALL NOT gain a plugins navigation tab.

Each catalogue entry SHALL render in exactly one of three supply states — 可启用 (supplied with the deployment image or desktop build, one enable toggle), 未供应 (present in the catalogue but not supplied, marked with a 申请供应 action), and 已启用 (supplied and enabled) — with its row metadata (id, description, enabled state, and error metadata when present). The tab SHALL offer no install, remove, or edit flow for a bundle and SHALL state in a hint that bundles are supplied by the deployment; the only mutations SHALL be the enable toggle and the 申请供应 request (per `plugin-supply-request`), which records the request for a later build bake and installs nothing at runtime.

A toggle SHALL surface the dsh-plugin-supply apply semantics: a toggle refused while the agent is streaming SHALL render the refusal reason and leave the row's reported state unchanged; an accepted toggle SHALL indicate it is being applied (recompose or child restart) and the tab SHALL refresh the catalogue when composition settles without requiring a page reload. Every existing `data-testid` attribute SHALL survive the move into the market tab.

#### Scenario: Plugins section appears beside MCP and Skills

- **WHEN** the user opens `/agents` and inspects its sub-tabs
- **THEN** the 插件 tab SHALL appear beside 工具 and 技能
- **AND** selecting it SHALL set the URL to `/agents?tab=plugins` and render the plugin catalogue
- **AND** the Settings modal SHALL NOT offer a Plugins section
- **AND** the sidebar SHALL NOT gain a plugins navigation tab

#### Scenario: three supply states render

- **WHEN** the user opens `/agents?tab=plugins`
- **THEN** a supplied, disabled bundle SHALL read 可启用 with its toggle off, a supplied and enabled bundle SHALL read 已启用 with its toggle on, and an entry the deployment does not supply SHALL read 未供应 with a 申请供应 action
- **AND** when the deployment supplies no bundle at all the tab SHALL still render with the catalogue's explanation rather than an empty shell

#### Scenario: unsupplied entries offer request supply

- **WHEN** the user activates 申请供应 on a 未供应 entry and confirms
- **THEN** the request SHALL be recorded (per `plugin-supply-request`) and acknowledged in the UI
- **AND** the row SHALL remain 未供应 until a later build supplies it — nothing SHALL be downloaded, installed, or executed at request time

#### Scenario: toggle reflects pending-vs-applied state

- **WHEN** the user flips a bundle's toggle while the runtime is idle
- **THEN** the UI SHALL indicate the change is being applied and SHALL refresh the inventory when composition settles
- **AND** if the apply required a child restart, existing chat sessions SHALL remain usable afterwards

#### Scenario: toggle refused while streaming

- **WHEN** the user attempts a toggle while the shared runtime is streaming
- **THEN** the UI SHALL present the busy refusal reason
- **AND** the row SHALL keep reporting the previous enabled state

#### Scenario: no install surface

- **WHEN** the user views the 插件 tab
- **THEN** there SHALL be no install, remove, or edit affordance for bundles
- **AND** a hint SHALL state that bundles are supplied by the deployment
- **AND** 申请供应 SHALL be presented as a supply request, not as an install

#### Scenario: failed bundle surfaces its error

- **WHEN** a supplied bundle carries an activation error
- **THEN** its row SHALL display the error metadata rather than hiding the row
