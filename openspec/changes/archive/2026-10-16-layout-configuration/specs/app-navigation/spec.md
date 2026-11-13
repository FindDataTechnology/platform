# app-navigation Specification Delta

## MODIFIED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set

The web UI SHALL provide a persistent left sidebar navigation whose view tabs are rendered from the unified surface registry (per `layout-configuration`) resolved through the deployment→role→user layout chain, with platform predicates applied. The factory `standard-snapshot` preset SHALL render, in order, the view tabs: **Chat, Knowledge, Resources, Agents, Apps, Tasks**, plus **Fleet** on the desktop shell only (its platform predicate; the browser hides it). These are the application's *work surfaces* — views the user visits to read or produce content. Operational surfaces SHALL NOT appear as view tabs: **MCP Servers**, **Skills**, and **Models** are sections of the Settings modal (see `settings-surface`), and the former **Bots** and **Trace** tabs are likewise Settings sections (渠道接入 `channels` and 诊断 `diagnostics`). The legacy "Dashboard" and "Documents" top-level entries SHALL remain absent; System Status is a Settings section at `/settings/status`. The legacy `/extensions` parent route SHALL NOT be registered; `/documents` redirects to `/knowledge`. Each view tab SHALL correspond to exactly one main-content panel; the Resources tab's panel is the resources page at `/resources`. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active. The displayed label of each view tab SHALL be resolved from the i18n bundle keyed by the registry's stable slug, so the label follows the active locale while the tab's identity, icon, and testid are stable. The zh-CN display names SHALL be user-language — Chat 对话, Knowledge 资料库, Resources 成果, Agents 智能体, Apps 应用, Tasks 自动化, Fleet 舰队 — while the underlying routes (`/chat`, `/knowledge`, `/resources`, `/agents`, `/apps`, `/tasks`, `/fleet`) SHALL NOT change. Preset resolution SHALL be able to hide or reorder tabs (per `layout-configuration`), never to add surfaces absent from the registry or defeat a platform predicate.

#### Scenario: initial load shows the Chat tab

- **WHEN** the page loads with no layout data anywhere (factory preset)
- **THEN** the sidebar SHALL render the view tabs Chat, Knowledge, Resources, Agents, Apps, Tasks in that order
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden
- **AND** no Extensions, Dashboard, Documents, Bots, or Trace top-level entry SHALL be present

#### Scenario: fleet hidden on web by platform predicate

- **WHEN** the sidebar renders in a browser (not the desktop shell)
- **THEN** the Fleet tab SHALL be absent even if a preset lists it

#### Scenario: canonical tab ordering and labels

- **WHEN** the sidebar renders under the factory preset
- **THEN** each tab SHALL display a label resolved from the `common` i18n bundle under a stable key, alongside a stable icon and testid
- **AND** the tab's stable identifier and ordering SHALL NOT change when the active locale changes
- **AND** the zh-CN labels SHALL read 对话, 资料库, 成果, 智能体, 应用, 自动化 (舰队 on desktop)

#### Scenario: configuration surfaces are absent from the nav

- **WHEN** the sidebar renders
- **THEN** no nav tab SHALL be present for MCP Servers, Skills, Models, System Status, Bots, or Trace
- **AND** those surfaces SHALL be reachable only as Settings sections (per `settings-surface`)

#### Scenario: Documents tab renamed to Knowledge

- **WHEN** the user views the sidebar in any locale
- **THEN** the tab previously labelled "Documents" SHALL be labelled "Knowledge" (zh-CN: 资料库)
- **AND** the underlying route SHALL be `/knowledge`
- **AND** the existing `/documents` route SHALL redirect to `/knowledge` so legacy deep-links do not 404

#### Scenario: Resources tab opens the resources page

- **WHEN** the user clicks the Resources tab, or navigates directly to `/resources`
- **THEN** the resources page SHALL render as the active panel

#### Scenario: Extensions parent is absent

- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/settings/mcp`
- **AND** no Extensions parent page SHALL be rendered

#### Scenario: resolved layout hides a tab

- **WHEN** the resolved layout for a user omits the Apps tab
- **THEN** the sidebar renders without the Apps tab and `/apps` deep links still resolve (hidden surfaces keep their routes; only the entry disappears)

## ADDED Requirements

### Requirement: Workbench customization entry

The sidebar footer area SHALL offer a workbench customization entry (工作面定制) that opens the user's layout adjustment surface (per `layout-configuration`): toggling visibility and reordering of the surfaces visible to that user, plus a restore control returning the inherited layout. The entry SHALL be present for every user regardless of preset, operating only within the user-adjustment bounds defined by `layout-configuration`.

#### Scenario: entry visible for every user

- **WHEN** the sidebar renders for any authenticated user
- **THEN** the workbench customization entry SHALL be present and open the adjustment surface on activation

#### Scenario: adjustment bounded by inherited layout

- **WHEN** a surface is hidden by the user's role or deployment layer
- **THEN** the adjustment surface does not list it, and no control exists to re-reveal it
