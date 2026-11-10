# layout-configuration Specification

## Purpose

布局是数据：统一页面注册表、版本化布局预设、部署默认→业务角色→用户微调的三层解析链（部署隐藏终局），与配套的部署管理面、用户微调面。兑现"不同客户切换整体布局"（ADR-0026）。

## Requirements

### Requirement: Unified surface registry

The system SHALL maintain a single surface registry covering exactly three containers in v1: primary navigation tabs, Settings sections, and the Agents page sub-tabs. Every surface SHALL be keyed by its existing public route slug, scoped to its container. The primary navigation container SHALL carry, in registry order, `chat`, `knowledge`, `resources`, `memory`, `agents`, `tuning`, `fleets`, `machines`, `fleet` (desktop-only), `tasks`, `apps`, `channels`, `zhiyu` — membership unchanged by the material-market unification, so `agents` stays one nav entry and no nav slug is added or removed; the Settings container SHALL carry, in registry order, `general`, `account`, `pairing`, `connections`, `models`, `roles`, `layout`, `delegation`, `branding`, `status`; the Agents page sub-tab container SHALL carry, in registry order, exactly five slugs: `agents` (智能体), `tools` (工具), `skills` (技能), `plugins` (插件), `mine` (我的). Each registry entry SHALL declare its container, its platform predicates (desktop-only, pack-marketplace-gated, documents-gated, admin-only) and its stable identity metadata (i18n key, icon, testid). Slugs SHALL NOT change and no surface SHALL exist outside the registry.

The five sub-tabs are the material market's species, and their predicates SHALL be exactly these: `agents` (智能体) SHALL keep the pack-marketplace platform predicate, so it is absent where the deployment reports no pack marketplace; `tools` (工具) and `skills` (技能) SHALL carry no platform predicate and SHALL always be present; `plugins` (插件) SHALL likewise always be present, because its catalogue is served by the deployment — a deployment that supplies nothing still renders the tab with the catalogue's explanation, never an absent or empty surface — and its staying present SHALL NOT be read as a supply promise, since whether its entries are 可启用、未供应 or 已启用 is the catalogue's state (per `dsh-plugin-supply`, `plugin-supply-request`); `mine` (我的) SHALL carry no predicate. The nav `agents` entry and the sub-tab `agents` are two container-scoped entries that share a slug: the nav entry is the sidebar door, the sub-tab is the market's first species, and neither renames the other.

Membership changes SHALL be additions and relocations of existing slugs, never renames: `tuning` graduates out of the agentsTabs container into the nav container (route `/tuning`) so it stops being a URL-only surface; `channels` moves from the Settings container into the nav container (社媒机器人是对外沟通面，不是配置); `pairing` is added to the Settings container as the merge of the retired `devices` and `wechat-app` slugs (同一码池三个 tab，两旧 slug 走 aliases per `settings-surface`); `delegation` is added to the Settings container; and the agentsTabs container is rewritten from the two-tab market (`market`, `mine`) into the five species slugs `agents`, `tools`, `skills`, `plugins`, `mine`, whose former four-zone slugs (`build`, `supply`, `creations`, plus the retired `apps`) and the retired browse slug `market` render no tab. The preset field name `agentsTabs` SHALL be retained unchanged so stored presets keep their key. A surface whose label changes SHALL keep its slug, i18n key and testid: the `fleet` slug SHALL stay `fleet` and SHALL keep its `desktopOnly` predicate and testid while its localized label becomes 本机运行时 (it is the desktop runner console, distinct from `fleets` 智能体团队 and `machines` 机器); the nav `agents` entry's localized label SHALL become 素材市场 in place of 智能体市场 while its slug `agents`, its `nav.agents` i18n key, its `nav-agents` testid and its route `/agents` stay stable — the market was renamed, the surface was not.

The `blueprints` slug SHALL remain in the nav container for stored-preset and deep-link compatibility while rendering no navigation entry — no factory preset lists it (unchanged rule). `diagnostics` SHALL leave the Settings container as a section and SHALL be reachable only as a tab of `status`, addressed through an alias per `settings-surface`. Retired agentsTabs slugs SHALL remain resolvable through `SURFACE_SLUG_ALIASES` so stored presets and legacy `?tab=` deep links stay valid: `market`→`agents` (the retired browse tab), `supply`→`agents`, `apps`→`agents`, `build`→`agents`, and `creations`→`mine`. `agents` SHALL NOT be an alias any more — it is a canonical tab slug — and `mine` SHALL keep its slug. A stored preset or deep link naming `market`, `supply`, `apps`, `build`, or `creations` SHALL stay valid, SHALL canonicalize to its mapped tab, and SHALL NOT become an unknown slug.

The Settings container of the registry and the Settings section definitions SHALL agree in both directions: every registry slug SHALL have exactly one section definition with the same slug, and every section definition's canonical slug SHALL have exactly one registry entry in the Settings container. A definition with no registry entry SHALL NOT be reachable — the Settings modal renders only registry-resolved slugs — and a registry slug with no definition SHALL NOT render an empty section. `mcp` and `plugins` SHALL be absent from both sides: the tools and plugin catalogues are work surfaces of the material market, their `/settings/*` URLs are route-level redirects there (per `settings-surface`), and neither SHALL be a Settings section or a section alias — the former `skills`→`mcp` alias inside the Settings container SHALL be retired for the same reason. This agreement is the invariant a surface such as `delegation` currently violates (present in the definitions, absent from the registry, therefore permanently unreachable).

#### Scenario: registry keys match public routes

- **WHEN** the registry is consumed to render any of the three containers
- **THEN** every rendered surface keeps its existing route slug, testid, and deep-link behavior
- **AND** the nav entry `agents` keeps `/agents` and `nav-agents` while the sub-tab `agents` carries the market's first-species content, neither displacing the other

#### Scenario: platform predicates are ungated by presets

- **WHEN** a preset lists the `fleet` surface as visible and the client is a browser (not the desktop shell)
- **THEN** the fleet tab does not render, and the same holds for every platform predicate
- **AND** on a deployment that reports no pack marketplace the `agents` sub-tab stays absent whatever the preset lists, while `tools`, `skills`, and `plugins` still render because they carry no predicate

#### Scenario: surfaces move between containers without changing their slug

- **WHEN** `tuning` leaves the agentsTabs container for the nav container and `channels` leaves the Settings container for the nav container
- **THEN** each keeps its route slug, i18n key, and testid, and each renders in its new container only
- **AND** the same rule holds for the species slugs installed into the agentsTabs container: `agents`, `tools`, `skills`, and `plugins` keep their routes and stable identity, and `mine` keeps its slug

#### Scenario: label change keeps stable identity

- **WHEN** the `fleet` entry's localized label becomes 本机运行时 and the nav `agents` entry's label becomes 素材市场
- **THEN** the `fleet` slug, i18n key, testid, and `desktopOnly` predicate are unchanged
- **AND** the `agents` slug, its `nav.agents` i18n key, its `nav-agents` testid, and its `/agents` route are unchanged, and no other slug is renamed

#### Scenario: registry and section definitions agree both ways

- **WHEN** the Settings section definitions table and the Settings container of the registry are compared
- **THEN** every definition has exactly one registry entry with the same slug, and every registry slug has exactly one definition — no section renders nowhere and no registry slug renders an empty section
- **AND** the Settings container holds exactly the ten slugs general, account, pairing, connections, models, roles, layout, delegation, branding, status, and `mcp` and `plugins` appear on neither side

#### Scenario: retired settings slugs resolve through aliases

- **WHEN** a stored preset or a `/settings/:section` deep link names `devices`, `wechat-app`, `channels`, `diagnostics`, or `skills`
- **THEN** it resolves to `pairing` (the first two, as tabs of the merged section), the nav-side `channels` surface, and the `status` section (as its diagnostics tab) respectively
- **AND** `skills` (and `mcp`) are no longer section aliases: their `/settings/*` URLs redirect at route level to the 技能 and 工具 tabs of the material market (per `settings-surface`), and neither opens the modal

#### Scenario: the agents sub-tab container is the five market species

- **WHEN** the registry's `agentsTabs` container is read
- **THEN** it is exactly `agents`, `tools`, `skills`, `plugins`, `mine`, in that order, with the labels 智能体, 工具, 技能, 插件, 我的
- **AND** no other slug renders a sub-tab on the `/agents` surface

#### Scenario: a retired browse slug still resolves

- **WHEN** a stored preset or a `?tab=` deep link names `market`
- **THEN** it canonicalizes to `agents` through `SURFACE_SLUG_ALIASES`, the preset stays valid, and the 智能体 tab is selected without error

#### Scenario: an empty plugin catalogue still renders its tab

- **WHEN** the deployment supplies no plugin bundle
- **THEN** the `plugins` sub-tab is present and renders its catalogue explanation rather than an empty or absent tab

### Requirement: Versioned layout preset schema

A layout preset SHALL be a versioned object declaring, per container, an ordered list of visible surface slugs (`version` plus `nav`, `settings`, `agentsTabs`). A slug absent from a container's list is hidden by that preset. The schema SHALL carry a version field so later revisions can extend scope (chat-internal panels, interaction modes) without rewriting stored presets. The system SHALL ship two factory presets: `standard-snapshot`, the default, whose `nav` list equals the unified surface registry's nav order exactly (including platform predicates) **minus** `blueprints` — the blueprint studio's nav entry is retired into the workspace redirect, while its registry slug remains so stored presets and deep links keep resolving — whose `settings` list equals the Settings container's registry order exactly, and whose `agentsTabs` list is exactly `agents`, `tools`, `skills`, `plugins`, `mine`; and `simple`, the non-technical skeleton — navigation limited to Chat, Knowledge, Resources, Memory, Agents, Apps（the app center is the discovery and connection entry every business user must reach）; Settings limited to the Basics group (General, Account), plus 配对与绑定 (`pairing`) and Connections, where `pairing` replaces the former `devices` and `wechat-app` members of that set; and `agentsTabs` exactly `agents`, `tools`, `skills`, `plugins`, `mine`. Both presets list all five species because the material market's tabs are everyday work surfaces, not advanced configuration; a deployment that wants a narrower market narrows it through the role or user layer, and hiding `agents` is exactly the pack-marketplace narrowing, never a way around the platform predicate. `channels`, `tasks`, `fleet`, `tuning` and `machines` SHALL remain outside `simple`.

Presets name surfaces to KEEP; absence hides. A preset that names a slug its container no longer carries SHALL have that entry ignored rather than treated as fatal: the unknown entry SHALL NOT reject the preset, SHALL NOT blank the container, and the remaining entries SHALL still narrow and order the container. A preset naming a retired agents-tab slug (`market`, `supply`, `apps`, `build`, `creations`) SHALL have that entry canonicalized through `SURFACE_SLUG_ALIASES` to `agents` or `mine` before the known-slug check, so the stored preset stays valid and lands on its successor rather than being reported as unknown.

#### Scenario: standard-snapshot equals the registry

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation equals the nav registry order item for item — Chat, Knowledge, Resources, Memory, 素材市场, 调优, 智能体团队, 机器, 本机运行时 (desktop only), Tasks, Apps, 渠道, 智语 — **except** that it omits the 蓝图构造间 entry (retired to the workspace redirect)
- **AND** the Settings modal shows every Settings registry slug, in registry order (General, Account, 配对与绑定, Connections, Models, Roles, Layout, 委托策略, Branding, Status)
- **AND** the Agents page renders exactly the 智能体, 工具, 技能, 插件, and 我的 sub-tabs, in that order

#### Scenario: standard-snapshot equals today's surfaces

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation SHALL equal the nav registry item for item — the pre-change flat set with `tuning` and `channels` added, `fleet` relabelled 本机运行时, the `agents` entry relabelled 素材市场, and family grouping applied for presentation only — **except** that it omits the 蓝图构造间 entry
- **AND** the factory preset SHALL have been updated to the new canonical set rather than frozen to the pre-change list

#### Scenario: stored layouts referencing the apps sub-tab degrade safely

- **WHEN** a stored preset or user adjustment lists `apps` in `agentsTabs`
- **THEN** resolution SHALL canonicalize it to `agents` while the `apps` nav slug stays addressable, no Apps sub-tab renders, and a `?tab=apps` deep link lands on the 智能体 tab without error

#### Scenario: simple preset hides technical surfaces

- **WHEN** the `simple` preset resolves for a user
- **THEN** the navigation shows Chat, Knowledge, Resources, Memory, Agents, Apps only, in registry order
- **AND** the Settings modal shows only General, Account, 配对与绑定, and Connections
- **AND** the Agents page renders exactly the 智能体, 工具, 技能, 插件, and 我的 sub-tabs, in that order

#### Scenario: business-role users reach the app center

- **WHEN** a non-administrator whose primary role resolves to the `simple` preset（e.g. `stock`）opens the workbench with no deployment-layer hiding of `apps`
- **THEN** the primary navigation carries the Apps entry and it opens the app center

#### Scenario: deployment hiding of apps stays terminal

- **WHEN** the deployment hides `apps` and the user's role preset is `simple`
- **THEN** the resolved navigation omits Apps（the role layer cannot reveal a deployment-hidden surface）

#### Scenario: stored layouts referencing retired agents sub-tabs degrade safely

- **WHEN** a stored preset or user adjustment lists `apps`, `supply`, `market`, `build`, or `creations` in `agentsTabs`
- **THEN** resolution SHALL canonicalize each through `SURFACE_SLUG_ALIASES` to `agents` or `mine`, keep the preset valid, and route a `?tab=<retired slug>` deep link to the mapped tab without error

#### Scenario: stored layouts naming blueprints keep resolving

- **WHEN** a stored preset or user adjustment lists `blueprints` in `nav` after the factory preset dropped it
- **THEN** validation accepts the slug (it remains in the registry) and the item renders for that user; a fresh resolution without stored layers shows no such entry

#### Scenario: preset naming a dropped container slug is ignored, not fatal

- **WHEN** a stored preset lists `channels` in `settings` after `channels` moved to the nav container
- **THEN** that entry is ignored, the preset is not rejected, the Settings container is not blanked, and its remaining entries still narrow and order the sections

### Requirement: Three-layer resolution with terminal deployment hiding

Layout resolution SHALL compose four layers per container: factory preset, deployment default, business-role preset, user adjustment — each layer MAY hide surfaces or reorder the remainder, and MAY NOT reveal a surface hidden by a less specific layer. Resolution SHALL be computed server-side from the user's business roles (per `role-system`), the deployment configuration, and the user's stored adjustments, and delivered as a single resolved layout. Deployment-layer hiding SHALL be terminal: no role preset or user adjustment SHALL re-reveal a deployment-hidden surface. User adjustments SHALL be limited to visibility toggling and reordering of surfaces still visible after the role layer.

The business-role layer SHALL NOT apply to administrators (users determined admin per `role-system`'s orthogonal flag): an administrator's resolution composes factory preset, deployment default (with its terminal hiding), and the administrator's own user adjustments only, regardless of any primary or secondary business role they hold. Non-administrators' resolution is unchanged.

The algorithm SHALL NOT change in this change: the containment and persona changes are registry membership, not precedence. What changes is only the set of surfaces the layers can narrow — `tuning` and `channels` narrow as nav surfaces, `pairing` and `delegation` as Settings sections, and the retired `channels`/`diagnostics` Settings members are no longer administration surfaces.

#### Scenario: deployment hide is terminal

- **WHEN** the deployment hides `tasks`, the user's role preset lists `tasks`, and the user re-enables it in workbench customization
- **THEN** the resolved layout still omits `tasks`

#### Scenario: role preset narrows within deployment default

- **WHEN** the deployment default is `standard-snapshot` and the user's business role presets `simple`
- **THEN** the resolved layout is `simple`'s narrowing of the deployment default, with user adjustments applied on top

#### Scenario: administrators are exempt from role narrowing

- **WHEN** an administrator holds primary role `stock` (whose preset is `simple`) and the deployment default is `standard-snapshot` with no deployment hiding
- **THEN** the resolved layout equals the deployment default for every container — the administration sections（models, roles, layout, delegation, status, branding…）and the full primary navigation are present
- **AND** `channels` SHALL appear in the navigation rather than among the administration sections, and `diagnostics` SHALL appear as a tab of `status`

#### Scenario: deployment hide stays terminal for administrators

- **WHEN** the deployment hides `fleet` and an administrator holds a business role
- **THEN** the administrator's resolved layout omits `fleet` and otherwise equals the deployment default

#### Scenario: resolution is delivered server-computed

- **WHEN** an authenticated user reads the boot config endpoint
- **THEN** the response carries the resolved layout for that user, and the client renders from it without recomputing layer precedence

### Requirement: Deployment layout administration

An admin-only Settings section (`layout`, per `settings-surface`) SHALL let the operator choose the deployment default preset, assign a preset per business role, and toggle per-surface deployment hiding, persisted at deployment level (gateway-side store on hosted deployments, the deployment config store locally) and effective without a server restart. Mutation SHALL be admin-gated; non-admin mutation SHALL be rejected with `403` and no stored change. Env seeding SHALL provide the same knobs (default preset, per-role preset map) with stored values winning.

#### Scenario: operator switches deployment default

- **WHEN** an admin sets the deployment default preset to `simple`
- **THEN** users without a role-specific preset or adjustments resolve to `simple` on their next config read, without a server restart

#### Scenario: non-admin cannot mutate deployment layout

- **WHEN** auth is on and a non-admin calls the deployment layout mutation endpoint
- **THEN** the server responds `403` and the stored layout is unchanged

### Requirement: User workbench customization

Each user SHALL get a sidebar entry (工作面定制) opening a customization surface that lists the surfaces visible to them after role-layer resolution and lets them toggle visibility and reorder within that set. Adjustments SHALL persist per user (in the existing per-user preference store), apply to that user only, and never re-reveal a surface hidden by a more specific-to-deployment layer or blocked by a platform predicate. A control SHALL restore the inherited layout (clearing the user's adjustments).

#### Scenario: user hides a tab for themselves

- **WHEN** a user hides the Apps tab in workbench customization
- **THEN** the sidebar omits Apps for that user only, and other users are unaffected

#### Scenario: restore inherited layout

- **WHEN** a user activates the restore control
- **THEN** their stored adjustments are cleared and the resolved layout returns to the role/deployment composition
