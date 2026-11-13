## MODIFIED Requirements

### Requirement: Unified surface registry

The system SHALL maintain a single surface registry covering exactly three containers in v1: primary navigation tabs, Settings sections, and the Agents page sub-tabs. Every surface SHALL be keyed by its existing public route slug. The primary navigation container SHALL carry, in registry order, `chat`, `knowledge`, `resources`, `memory`, `agents`, `tuning`, `fleets`, `machines`, `fleet` (desktop-only), `tasks`, `apps`, `channels`, `zhiyu`; the Settings container SHALL carry, in registry order, `general`, `account`, `pairing`, `connections`, `mcp`, `plugins`, `models`, `roles`, `layout`, `delegation`, `branding`, `status`; the Agents page sub-tab container SHALL carry `market` (市场) and `mine` (我的/草稿) in that order. Each registry entry SHALL declare its container, its platform predicates (desktop-only, pack-marketplace-gated, documents-gated, admin-only) and its stable identity metadata (i18n key, icon, testid). Slugs SHALL NOT change and no surface SHALL exist outside the registry.

Membership changes SHALL be additions and relocations of existing slugs, never renames: `tuning` graduates out of the agentsTabs container into the nav container (route `/tuning`) so it stops being a URL-only surface; `channels` moves from the Settings container into the nav container (社媒机器人是对外沟通面，不是配置); `pairing` is added to the Settings container as the merge of the retired `devices` and `wechat-app` slugs (同一码池三个 tab，两旧 slug 走 aliases per `settings-surface`); `delegation` is added to the Settings container; `market` and `mine` are added to the agentsTabs container, whose former four-zone slugs (`build`, `supply`, `creations`, plus the retired `apps`) render no tab. A surface whose label changes SHALL keep its slug, i18n key and testid: the `fleet` slug SHALL stay `fleet` and SHALL keep its `desktopOnly` predicate and testid while its localized label becomes 本机运行时 (it is the desktop runner console, distinct from `fleets` 智能体团队 and `machines` 机器).

The `blueprints` slug SHALL remain in the nav container for stored-preset and deep-link compatibility while rendering no navigation entry — no factory preset lists it (unchanged rule). `diagnostics` SHALL leave the Settings container as a section and SHALL be reachable only as a tab of `status`, addressed through an alias per `settings-surface`. Retired agentsTabs slugs SHALL remain resolvable through `SURFACE_SLUG_ALIASES` so stored presets and legacy `?tab=` deep links stay valid: `supply`→`market`, `creations`→`mine`, `agents`→`mine`, `apps`→`market`; `build` SHALL likewise keep a resolving alias entry and SHALL NOT become an unknown slug.

The Settings container of the registry and the Settings section definitions SHALL agree in both directions: every registry slug SHALL have exactly one section definition with the same slug, and every section definition's canonical slug SHALL have exactly one registry entry in the Settings container. A definition with no registry entry SHALL NOT be reachable — the Settings modal renders only registry-resolved slugs — and a registry slug with no definition SHALL NOT render an empty section. This agreement is the invariant a surface such as `delegation` currently violates (present in the definitions, absent from the registry, therefore permanently unreachable).

#### Scenario: registry keys match public routes

- **WHEN** the registry is consumed to render any of the three containers
- **THEN** every rendered surface keeps its existing route slug, testid, and deep-link behavior

#### Scenario: platform predicates are ungated by presets

- **WHEN** a preset lists the `fleet` surface as visible and the client is a browser (not the desktop shell)
- **THEN** the fleet tab does not render, and the same holds for every platform predicate

#### Scenario: surfaces move between containers without changing their slug

- **WHEN** `tuning` leaves the agentsTabs container for the nav container and `channels` leaves the Settings container for the nav container
- **THEN** each keeps its route slug, i18n key, and testid, and each renders in its new container only

#### Scenario: label change keeps stable identity

- **WHEN** the `fleet` entry's localized label becomes 本机运行时
- **THEN** its slug, i18n key, testid, and `desktopOnly` predicate are unchanged, and no other slug is renamed

#### Scenario: registry and section definitions agree both ways

- **WHEN** the Settings section definitions table and the Settings container of the registry are compared
- **THEN** every definition has exactly one registry entry with the same slug, and every registry slug has exactly one definition — no section renders nowhere and no registry slug renders an empty section

#### Scenario: retired settings slugs resolve through aliases

- **WHEN** a stored preset or a `/settings/:section` deep link names `devices`, `wechat-app`, `channels`, `diagnostics`, or `skills`
- **THEN** it resolves to `pairing` (the first two, as tabs of the merged section), the nav-side `channels` surface, the `status` section (as its diagnostics tab), and `mcp` respectively, without error

### Requirement: Versioned layout preset schema

A layout preset SHALL be a versioned object declaring, per container, an ordered list of visible surface slugs (`version` plus `nav`, `settings`, `agentsTabs`). A slug absent from a container's list is hidden by that preset. The schema SHALL carry a version field so later revisions can extend scope (chat-internal panels, interaction modes) without rewriting stored presets. The system SHALL ship two factory presets: `standard-snapshot`, the default, whose `nav` list equals the unified surface registry's nav order exactly (including platform predicates) **minus** `blueprints` — the blueprint studio's nav entry is retired into the workspace redirect, while its registry slug remains so stored presets and deep links keep resolving — whose `settings` list equals the Settings container's registry order exactly, and whose `agentsTabs` list is exactly `market`, `mine`; and `simple`, the non-technical skeleton — navigation limited to Chat, Knowledge, Resources, Memory, Agents, Apps（the app center is the discovery and connection entry every business user must reach）; Settings limited to the Basics group (General, Account), plus 配对与绑定 (`pairing`) and Connections, where `pairing` replaces the former `devices` and `wechat-app` members of that set; and `agentsTabs` exactly `market`, `mine`. `channels`, `tasks`, `fleet`, `tuning` and `machines` SHALL remain outside `simple`.

Presets name surfaces to KEEP; absence hides. A preset that names a slug its container no longer carries SHALL have that entry ignored rather than treated as fatal: the unknown entry SHALL NOT reject the preset, SHALL NOT blank the container, and the remaining entries SHALL still narrow and order the container.

#### Scenario: standard-snapshot equals the registry

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation equals the nav registry order item for item — Chat, Knowledge, Resources, Memory, Agents, 调优, 智能体团队, 机器, 本机运行时 (desktop only), Tasks, Apps, 渠道, 智语 — **except** that it omits the 蓝图构造间 entry (retired to the workspace redirect)
- **AND** the Settings modal shows every Settings registry slug, in registry order (General, Account, 配对与绑定, Connections, MCP, Plugins, Models, Roles, Layout, 委托策略, Branding, Status)
- **AND** the Agents page renders exactly the 市场 and 我的 sub-tabs, in that order

#### Scenario: standard-snapshot equals today's surfaces

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation SHALL equal the nav registry item for item — the pre-change flat set with `tuning` and `channels` added, `fleet` relabelled 本机运行时, and family grouping applied for presentation only — **except** that it omits the 蓝图构造间 entry
- **AND** the factory preset SHALL have been updated to the new canonical set rather than frozen to the pre-change list

#### Scenario: stored layouts referencing the apps sub-tab degrade safely

- **WHEN** a stored preset or user adjustment lists `apps` in `agentsTabs`
- **THEN** resolution SHALL canonicalize it to `market` while the `apps` slug stays addressable, no Apps tab renders, and a `?tab=apps` deep link falls back to the first visible tab without error

#### Scenario: simple preset hides technical surfaces

- **WHEN** the `simple` preset resolves for a user
- **THEN** the navigation shows Chat, Knowledge, Resources, Memory, Agents, Apps only, in registry order
- **AND** the Settings modal shows only General, Account, 配对与绑定, and Connections
- **AND** the Agents page renders exactly the 市场 and 我的 sub-tabs, in that order

#### Scenario: business-role users reach the app center

- **WHEN** a non-administrator whose primary role resolves to the `simple` preset（e.g. `stock`）opens the workbench with no deployment-layer hiding of `apps`
- **THEN** the primary navigation carries the Apps entry and it opens the app center

#### Scenario: deployment hiding of apps stays terminal

- **WHEN** the deployment hides `apps` and the user's role preset is `simple`
- **THEN** the resolved navigation omits Apps（the role layer cannot reveal a deployment-hidden surface）

#### Scenario: stored layouts referencing retired agents sub-tabs degrade safely

- **WHEN** a stored preset or user adjustment lists `apps`, `supply`, `creations`, `agents`, or `build` in `agentsTabs`
- **THEN** resolution SHALL canonicalize each through `SURFACE_SLUG_ALIASES` to `market` or `mine`, keep the preset valid, and route a `?tab=<retired slug>` deep link to the mapped tab without error

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
