## MODIFIED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set

The web UI SHALL provide a persistent left sidebar navigation whose view tabs are rendered from the unified surface registry (per `layout-configuration`) resolved through the deployment→role→user layout chain, with platform predicates applied. The factory `standard-snapshot` preset SHALL render, in order, the view tabs: **Chat, Knowledge, Resources, Memory, Agents, Apps, Tasks, Fleets, Machines, Zhiyu**, plus **Fleet** on the desktop shell only (its platform predicate; the browser hides it) — the registry also carries the 蓝图构造间 `blueprints` slug, whose nav entry is retired into the workspace redirect (per `layout-configuration`), so it renders no tab. These are the application's *work surfaces* — views the user visits to read or produce content. Operational surfaces SHALL NOT appear as view tabs: **MCP Servers**, **Skills**, and **Models** are sections of the Settings modal (see `settings-surface`), and the former **Bots** and **Trace** tabs are likewise Settings sections (渠道接入 `channels` and 诊断 `diagnostics`). The legacy "Dashboard" and "Documents" top-level entries SHALL remain absent; System Status is a Settings section at `/settings/status`. The legacy `/extensions` parent route SHALL NOT be registered; `/documents` redirects to `/knowledge`. Each view tab SHALL correspond to exactly one main-content panel; the Resources tab's panel is the resources page at `/resources`, and the Agents tab's panel is the agent builder hub at `/agents` (per `agent-builder-hub`). On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active. The displayed label of each view tab SHALL be resolved from the i18n bundle keyed by the registry's stable slug, so the label follows the active locale while the tab's identity, icon, and testid are stable. The zh-CN display names SHALL be user-language — Chat 对话, Knowledge 资料库, Resources 成果, Memory 记忆, Agents 智能体构建器, Apps 应用, Tasks 自动化, Fleets 智能体团队, Machines 机器, Zhiyu 智语, Fleet 机群 — while the underlying routes (`/chat`, `/knowledge`, `/resources`, `/memory`, `/agents`, `/apps`, `/tasks`, `/fleets`, `/machines`, `/zhiyu`, `/fleet`) SHALL NOT change. Preset resolution SHALL be able to hide or reorder tabs (per `layout-configuration`), never to add surfaces absent from the registry or defeat a platform predicate.

#### Scenario: initial load shows the Chat tab

- **WHEN** the page loads with no layout data anywhere (factory preset)
- **THEN** the sidebar SHALL render the view tabs Chat, Knowledge, Resources, Memory, Agents, Apps, Tasks, Fleets, Machines, Zhiyu in that order
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
- **AND** the zh-CN labels SHALL read 对话, 资料库, 成果, 记忆, 智能体构建器, 应用, 自动化, 智能体团队, 机器, 智语 (机群 on desktop)

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

#### Scenario: Agents tab opens the builder hub

- **WHEN** the user clicks the Agents tab, or navigates directly to `/agents`
- **THEN** the agent builder hub SHALL render as the active panel with its four areas (per `agent-builder-hub`)
- **AND** the tab's slug, icon, and testid SHALL be unchanged from the previous 智能体 entry

#### Scenario: Extensions parent is absent

- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/settings/mcp`
- **AND** no Extensions parent page SHALL be rendered

#### Scenario: resolved layout hides a tab

- **WHEN** the resolved layout for a user omits the Apps tab
- **THEN** the sidebar renders without the Apps tab and `/apps` deep links still resolve (hidden surfaces keep their routes; only the entry disappears)
