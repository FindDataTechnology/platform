# extension-management-ui Specification

## Purpose
The Settings UI for managing MCP servers (`/settings/mcp`) and skills (`/settings/skills`): an Installed tab listing every configured entry with status and an enable / disable toggle plus add, edit and remove flows (MCP forms generated from the market entry's `configTemplate` when it requires configuration, edits preserving unmodelled fields such as `envRefs`; skill forms accepting markdown or a zip skill package), and a Market tab split into the platform catalog zone and the external-skill zone whose installs go through a consent panel first.

## Requirements

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

### Requirement: Installed tab lists all configured MCP servers
The Installed tab SHALL display a list of all configured MCP servers with their name, description (if available), connection status (connected/disconnected/error), and an enable/disable toggle.

#### Scenario: MCP servers are displayed
- **WHEN** the user views the Installed tab
- **THEN** the UI SHALL list each configured MCP server
- **AND** each entry SHALL show the server name, status indicator, and enable/disable toggle
- **AND** the list SHALL be sorted alphabetically by server name

#### Scenario: No MCP servers configured
- **WHEN** no MCP servers are configured
- **THEN** the UI SHALL display an empty state with a message "No MCP servers configured" and a button to add one

### Requirement: Installed tab lists all configured skills
The Installed tab SHALL display a list of all configured skills with their name, description, source (built-in or custom), and an enable/disable toggle.

#### Scenario: Skills are displayed
- **WHEN** the user views the Installed tab
- **THEN** the UI SHALL list each configured skill
- **AND** each entry SHALL show the skill name, description, source badge, and enable/disable toggle
- **AND** the list SHALL be sorted alphabetically by skill name

#### Scenario: No skills configured
- **WHEN** no skills are configured
- **THEN** the UI SHALL display an empty state with a message "No skills configured"

### Requirement: User can add a new MCP server
The UI SHALL provide an "Add MCP Server" button that opens a form to configure a new MCP server with fields for name, type (stdio or http), and type-specific configuration (command/args/env for stdio; url/headers for http).

#### Scenario: User adds a stdio MCP server
- **WHEN** the user clicks "Add MCP Server", selects type "stdio", fills in name, command, and args
- **AND** clicks "Save"
- **THEN** the server SHALL validate the configuration
- **AND** add the server to the MCP configuration
- **AND** attempt to connect to the server
- **AND** display the new server in the list with its connection status

#### Scenario: User adds an HTTP MCP server
- **WHEN** the user clicks "Add MCP Server", selects type "http", fills in name, URL, and optional headers
- **AND** clicks "Save"
- **THEN** the server SHALL validate the configuration
- **AND** add the server to the MCP configuration
- **AND** attempt to connect to the server
- **AND** display the new server in the list with its connection status

#### Scenario: Invalid configuration
- **WHEN** the user submits invalid configuration (e.g., missing required fields, malformed URL)
- **THEN** the UI SHALL display validation errors
- **AND** SHALL NOT save the configuration

### Requirement: User can remove an MCP server
The UI SHALL provide a "Remove" button for each MCP server that removes the server from the configuration and disconnects it.

#### Scenario: User removes an MCP server
- **WHEN** the user clicks "Remove" on an MCP server entry
- **AND** confirms the action in a confirmation dialog
- **THEN** the server SHALL disconnect from the MCP server
- **AND** remove it from the configuration
- **AND** remove it from the list

### Requirement: User can edit an MCP server configuration
The UI SHALL provide an "Edit" button for each MCP server that opens the configuration form pre-filled with the current values. Saving SHALL preserve config fields the form does not model (notably `envRefs` on stdio servers) rather than dropping them, and SHALL NOT silently strip a bundled server's deployment wiring.

#### Scenario: User edits an MCP server
- **WHEN** the user clicks "Edit" on an MCP server entry
- **THEN** the UI SHALL open the configuration form with current values pre-filled
- **AND** when the user saves changes, the server SHALL disconnect from the old configuration
- **AND** reconnect with the new configuration
- **AND** update the list entry

#### Scenario: Editing preserves unmodeled config fields
- **WHEN** the user edits a server whose config carries fields the form does not render (e.g. `envRefs`) and saves without touching them
- **THEN** the saved config SHALL retain those fields unchanged

#### Scenario: Bundled server wiring points to its settings section
- **WHEN** a bundled server's deployment wiring is managed by a dedicated settings section (the search-service card in the connections section, per `connection-center`)
- **THEN** its edit surface SHALL indicate where the wiring is configured instead of inviting an edit that would strip it

### Requirement: User can enable or disable an MCP server
The enable/disable toggle SHALL control whether the MCP server is active. Disabled servers remain in the configuration but are not connected.

#### Scenario: User disables an MCP server
- **WHEN** the user toggles off an MCP server
- **THEN** the server SHALL disconnect from the MCP server
- **AND** mark it as disabled in the configuration
- **AND** the UI SHALL show the server as disabled (greyed out)

#### Scenario: User enables an MCP server
- **WHEN** the user toggles on a disabled MCP server
- **THEN** the server SHALL attempt to connect to the MCP server
- **AND** update the status indicator

### Requirement: User can add a custom skill

The UI SHALL provide an "Add Custom Skill" button that opens a form to create a new skill with fields for name, description, and skill content (markdown). The form SHALL additionally accept a skill package upload (zip): the package is parsed server-side under the platform's package contract, and the UI shows the resulting inventory — the body excerpt, every file's path, script files highlighted, and any file omitted for size or non-text kind marked as omitted — before the skill is created. A package whose parse fails SHALL surface the named cause and create nothing. The manual paste path (name, description, content) SHALL keep working unchanged, and a package without auxiliary files creates the same single-file skill as the manual path.

#### Scenario: User adds a custom skill

- **WHEN** the user clicks "Add Custom Skill", fills in name, description, and content
- **AND** clicks "Save"
- **THEN** the server SHALL create a new SKILL.md file in the skills directory
- **AND** register the skill with the agent
- **AND** display the new skill in the list

#### Scenario: User uploads a skill package

- **WHEN** the user uploads a zip containing a skill document, two reference files, and one script, and confirms the shown inventory
- **THEN** the skill is created with its auxiliary file set, materializes as a directory tree, and appears in the list with its file inventory

#### Scenario: Script files are highlighted before creation

- **WHEN** the uploaded package contains script files
- **THEN** the inventory shown before creation marks every script file

#### Scenario: Rejected package creates nothing

- **WHEN** the uploaded package has no skill document, or a path escaping the package root
- **THEN** the UI shows the named error and no skill is created

### Requirement: User can remove a custom skill
The UI SHALL provide a "Remove" button for custom skills that deletes the skill file and unregisters it.

#### Scenario: User removes a custom skill
- **WHEN** the user clicks "Remove" on a custom skill entry
- **AND** confirms the action
- **THEN** the server SHALL delete the SKILL.md file
- **AND** unregister the skill from the agent
- **AND** remove it from the list

#### Scenario: Built-in skills cannot be removed
- **WHEN** a skill is marked as built-in
- **THEN** the "Remove" button SHALL NOT be displayed

### Requirement: User can edit a custom skill
The UI SHALL provide an "Edit" button for custom skills that opens the skill editor with current content.

#### Scenario: User edits a custom skill
- **WHEN** the user clicks "Edit" on a custom skill
- **THEN** the UI SHALL open the skill editor with current content pre-filled
- **AND** when the user saves changes, the server SHALL update the SKILL.md file
- **AND** re-register the skill with the agent

### Requirement: User can enable or disable a skill
The enable/disable toggle SHALL control whether the skill is available to the agent. Disabled skills remain in the configuration but are not registered.

#### Scenario: User disables a skill
- **WHEN** the user toggles off a skill
- **THEN** the server SHALL unregister the skill from the agent
- **AND** mark it as disabled
- **AND** the UI SHALL show the skill as disabled

#### Scenario: User enables a skill
- **WHEN** the user toggles on a disabled skill
- **THEN** the server SHALL register the skill with the agent
- **AND** update the UI to show it as enabled

### Requirement: MCP setup form is generated from config template
When the user installs an MCP server from the market whose `requiresConfig` is `true`, the add-server form SHALL render in a setup mode generated from the entry's `configTemplate`, rather than pre-filling the raw manual-add fields with placeholder strings. The form SHALL be data-driven from the template — one labeled field per `configTemplate.env` key and one labeled field per placeholder argument — not hardcoded per server.

#### Scenario: setup form renders a field per env key
- **WHEN** the user clicks "Install" on a needs-config MCP server whose template has `env: { GITHUB_PERSONAL_ACCESS_TOKEN: "your_token_here" }`
- **THEN** the form SHALL render a labeled text input whose label is the env key `GITHUB_PERSONAL_ACCESS_TOKEN`
- **AND** the input SHALL be empty with the template's placeholder value as a hint
- **AND** the template's `installInstructions` SHALL be shown as help text

#### Scenario: setup form renders a field per placeholder argument
- **WHEN** the user clicks "Install" on a needs-config MCP server whose template has `args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]`
- **THEN** the form SHALL render a labeled text input for the `/path/to/allowed/directory` argument
- **AND** the literal arguments `-y` and `@modelcontextprotocol/server-filesystem` SHALL be shown as read-only, non-editable values

#### Scenario: Add is disabled until required fields are filled
- **WHEN** the setup form is open and one or more placeholder fields are empty
- **THEN** the Add button SHALL be disabled
- **WHEN** the user fills every placeholder field with a non-empty value
- **THEN** the Add button SHALL become enabled

#### Scenario: submitted config is reconstructed from field values
- **WHEN** the user fills the setup form fields and clicks Add
- **THEN** the system SHALL reconstruct the server config by preserving template literal arguments in order and substituting the filled values into placeholder positions
- **AND** the `env` object SHALL contain only the filled env-key values
- **AND** the server SHALL be added with the reconstructed config and appear in the Installed tab

#### Scenario: manual add and edit keep the raw form
- **WHEN** the user clicks "Add MCP" without a market template, or clicks "Edit" on an existing server
- **THEN** the form SHALL render the raw manual-add fields (command, args, env JSON, url, headers JSON) as before
- **AND** the setup-mode fields SHALL NOT be rendered

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

### Requirement: External skill install flow presents a consent panel before installing

The external-source shelf's entry detail SHALL offer an install action that first opens a consent panel rather than installing directly. The panel SHALL present, before confirmation: what will be installed (skill body excerpt), the package's file inventory with executable-content files (scripts etc.) visually marked, the license state/text as mirrored from upstream, and the upstream origin address. The panel SHALL require an explicit confirmation control before the install action becomes available, and after completion it SHALL report the outcome — success (naming the installed skill) or an explicit failure reason. The "not reviewed by this platform" provenance mark SHALL remain visible on the detail and in the consent panel; the shelf itself SHALL remain browse-only in the sense that no install happens without this per-entry, per-action confirmation.

#### Scenario: install opens the consent panel first

- **WHEN** the user clicks install on an external entry's detail
- **THEN** a consent panel opens showing the body excerpt, file inventory, script marking, license state, and upstream address — nothing is installed until the user confirms

#### Scenario: script-bearing skill requires explicit acknowledgement

- **WHEN** the preview lists executable-content files
- **THEN** the panel presents the script warning and requires the user's explicit acknowledgement before the confirm action is enabled

#### Scenario: successful install reports the outcome

- **WHEN** the user confirms and the server installs the skill
- **THEN** the panel (or the surface that replaces it) reports success and names the installed skill, and the installed skill appears in the installed-skills listing

#### Scenario: failed install reports the reason

- **WHEN** the install request fails (upstream gone, name conflict, package limits)
- **THEN** the panel reports the failure reason returned by the server and does not present the skill as installed

#### Scenario: not-reviewed mark persists through the flow

- **WHEN** the user views an entry's detail or its consent panel
- **THEN** the "not reviewed by this platform" mark remains visible alongside the license state

### Requirement: Market tab presents catalog and external zones

The Market tab SHALL organize its content into two labeled zones: **市场目录**（the platform catalog of MCP servers / skills）and **外部市场**（the external skill shelf carrying the "not reviewed by this platform" posture, per `external-skill-sources`). The external zone SHALL appear only in the skills sub-view; the tools (mcp) sub-view SHALL NOT render the external zone — the tools sub-view's market tab SHALL present the catalog zone only.

#### Scenario: skills sub-view shows both zones

- **WHEN** the user opens the Market tab in the skills sub-view
- **THEN** both the catalog zone and the external zone render, with the external zone's unreviewed posture visible

#### Scenario: tools sub-view shows catalog only

- **WHEN** the user opens the Market tab in the tools (mcp) sub-view
- **THEN** only the catalog zone renders and no external-market zone is present

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
