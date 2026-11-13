## MODIFIED Requirements

### Requirement: Settings modal surface

The web UI SHALL provide a Settings modal that overlays the current view rather than replacing it. The modal SHALL organize its sections into three stable groups, in order — **Basics（常规）**, **Capabilities（能力）**, **Management（管理）** — holding exactly twelve sections:

- Basics（常规）: **General（通用）**, **Account（账户）**, **Pairing（配对与绑定）**
- Capabilities（能力）: **Connections（连接）**, **Tools & Skills（技能与工具）**, **Plugins（插件）**, **Models（模型）**
- Management（管理）: **User roles（用户角色）**, **Workbench layout（工作面布局）**, **Delegation（委托策略）**, **Deployment branding（部署品牌）**, **System Status（系统状态）**

Each section SHALL be identified by a stable slug which forms part of its URL and SHALL NOT change: `general`, `account`, `pairing`, `connections`, `mcp`, `plugins`, `models`, `roles`, `layout`, `delegation`, `branding`, `status`.

`pairing` SHALL be the single section that binds the current account to external clients, and SHALL present three internal tabs — 小程序 (mini program), 桌面应用 (desktop app), 机器 (machine) — because all three mint from the same single-use 5-minute bind-code pool. The retired `devices` and `wechat-app` slugs SHALL remain addressable as aliases of `pairing` and SHALL open it with the corresponding tab preselected (`devices` → 桌面应用, `wechat-app` → 小程序); they SHALL NOT be separate sections. Their deep links, including `/settings/devices?bindcode=<code>` and `/settings/wechat-app?bindcode=<code>`, SHALL keep working and SHALL keep preselecting their tab.

The former `channels` section SHALL leave the Settings modal entirely and become a nav surface at `/channels` (per `app-navigation` and `social-bot-channels`); `/settings/channels` and `/bots` SHALL redirect to `/channels`, and the bots management page SHALL no longer render inside the modal. The former `diagnostics` section SHALL be merged into `status` as a tab (状态 = 健康 + 逐回合追踪); the `diagnostics` slug SHALL remain addressable as an alias of `status` opening the per-turn trace tab, and `/trace` SHALL keep redirecting there.

The former `websearch` section is retired as a rendered section; its `/settings/websearch` URL SHALL redirect to `/settings/connections?panel=search` (per `connection-center`) so existing deep links keep resolving — the slug remains stably addressable through this redirect rather than as a section pane. The merged Tools & Skills section SHALL additionally remain addressable at the legacy `skills` slug, with each of the two slugs (`mcp`, `skills`) opening the section with its corresponding sub-view active (tools vs skills), so existing deep links keep resolving. The former `packs` and `presets` sections are retired from Settings; their `/settings/packs` and `/settings/presets` URLs redirect to the corresponding `/agents` sub-tabs (per `agent-catalog`). Section labels SHALL resolve from the internationalization resource bundle keyed by the stable slug, so the label follows the active locale while the slug, ordering, and icon remain stable; user-facing zh-CN copy SHALL use user-language terms (连接, 技能与工具, 插件, 模型, 用户角色, 工作面布局, 委托策略, 部署品牌) and SHALL NOT surface developer vocabulary such as "MCP" in section labels.

The modal SHALL present an in-modal search field above the section list that filters the sections by their label text in the active locale. Filtering SHALL be client-side, over the already-resolved list, and SHALL NOT bypass resolved-layout hiding, section predicates, or the admin-only rules: a section hidden by layout or predicate SHALL NOT become visible because its label matches the query. With an empty query the list SHALL render unchanged; a query that matches no section SHALL render an explicit no-match line rather than an empty pane.

The modal SHALL be dismissible and SHALL restore the user to the view they opened it from, with that view's scroll position preserved.

The **User roles** and **Workbench layout** sections SHALL be admin-only when auth is on and visible to everyone when auth is off, matching the server-side gates on their routes (per `role-system` and `layout-configuration`).

The rendered section list SHALL honor the resolved layout for the user (per `layout-configuration`): the factory preset renders the full canonical list above; a narrower preset hides sections, and deployment-hiding is terminal.

The rendered section list SHALL be generated only from registry-resolved slugs: every section the modal can render SHALL exist in the `settings` surface registry, and every settings section definition SHALL be registered. A section definition absent from the registry SHALL NOT be silently dropped from the modal without a test-visible failure — the section definitions and the surface registry SHALL agree, so a section cannot exist in one place and not the other.

A section's declared group SHALL agree with its position in the canonical section list: members of a group SHALL be listed contiguously, and the modal SHALL render a group heading exactly once per group, at the group's first visible member. A group with no visible member SHALL render no heading.

#### Scenario: modal overlays the current view

- **WHEN** the user opens Settings from the chat view
- **THEN** the Settings modal SHALL render above the chat view
- **AND** the chat view SHALL remain mounted beneath the modal
- **AND** the chat view SHALL NOT be unmounted or remounted

#### Scenario: canonical section set and ordering

- **WHEN** the Settings modal renders for an admin (or auth is off) under the factory preset
- **THEN** it SHALL present exactly twelve sections in three groups, Basics, Capabilities, Management, in that order: General, Account, Pairing; Connections, Tools & Skills, Plugins, Models; User roles, Workbench layout, Delegation, Deployment branding, System Status
- **AND** each section label SHALL be resolved from the i18n bundle under a stable key
- **AND** the section slugs, grouping, and ordering SHALL NOT change when the active locale changes
- **AND** no Packs, Custom presets, Channels, or Diagnostics section SHALL be present
- **AND** each group heading SHALL appear exactly once, at the first section of its group

#### Scenario: group membership agrees with list position

- **WHEN** the modal renders the section list in canonical order
- **THEN** consecutive sections with different declared groups SHALL be exactly the group boundaries, so each of Basics, Capabilities, Management is listed contiguously
- **AND** no group heading SHALL be re-emitted after the list has moved past that group
- **AND** a section whose declared group disagrees with its position SHALL fail the settings registry test rather than render an interleaved heading

#### Scenario: every section definition is registry-resolved

- **WHEN** the settings section definitions are compared with the `settings` entries of the surface registry
- **THEN** the two sets of canonical slugs SHALL be equal
- **AND** a slug present in one and absent from the other SHALL fail a test-visible check
- **AND** the modal SHALL render no section that the surface registry does not resolve

#### Scenario: delegation is reachable from the list

- **WHEN** an admin (or auth off) opens the Settings modal under the factory preset
- **THEN** the Management group SHALL list the Delegation section
- **AND** selecting it SHALL open `/settings/delegation` with the delegation pane active
- **AND** its heading SHALL render within the single Management run, not interleaved into another group

#### Scenario: pairing section with three tabs and alias deep links

- **WHEN** the user opens `/settings/pairing`
- **THEN** the section SHALL present three tabs, 小程序, 桌面应用, and 机器, which draw from the same single-use 5-minute bind-code pool
- **WHEN** the user opens `/settings/devices`
- **THEN** the Pairing section SHALL be active with the 桌面应用 tab preselected
- **WHEN** the user opens `/settings/wechat-app`
- **THEN** the Pairing section SHALL be active with the 小程序 tab preselected

#### Scenario: status hosts health and per-turn trace

- **WHEN** the user opens `/settings/status`
- **THEN** the System Status section SHALL be active with the health tab preselected
- **WHEN** the user opens `/settings/diagnostics`
- **THEN** the System Status section SHALL be active with the per-turn trace tab preselected

#### Scenario: search filters sections by label

- **WHEN** the user types a query into the in-modal search field
- **THEN** the section list SHALL show only sections whose label in the active locale contains the query
- **AND** clearing the query SHALL restore the full resolved list
- **WHEN** the query matches no section
- **THEN** the list SHALL render an explicit no-match line rather than an empty pane

#### Scenario: search never widens the visible set

- **WHEN** the resolved layout or a section predicate hides a section, and the user types text matching that section's label
- **THEN** the section SHALL remain hidden
- **AND** no `/settings/<slug>` navigation SHALL be possible to a section the resolver did not return

#### Scenario: retired websearch section redirects to connections

- **WHEN** the user navigates to `/settings/websearch` (typed, bookmarked, or from an old deep link)
- **THEN** the router SHALL redirect to `/settings/connections?panel=search`
- **AND** the Settings modal SHALL open with the connections section active and the search-service card prominent

#### Scenario: roles and layout sections hidden from non-admins

- **WHEN** auth is on and a non-admin user opens Settings
- **THEN** the Management group renders without the User roles and Workbench layout sections
- **AND** navigating to `/settings/roles` or `/settings/layout` directly resolves per the unrecognized-slug rule (first visible section fallback)

#### Scenario: dismissing restores the underlying view

- **WHEN** the Settings modal is open over a view and the user dismisses it
- **THEN** the modal SHALL close
- **AND** the underlying view SHALL become interactive again with its scroll position unchanged

### Requirement: Settings sections are addressable at `/settings/:section`

Each Settings section SHALL be addressable at the route `/settings/<slug>`. Navigating to such a URL SHALL open the modal with that section active. The route `/settings` with no section SHALL resolve to the first visible section (`/settings/general` under the factory preset). An unrecognized section slug SHALL resolve to the first visible section rather than rendering an empty modal or a 404.

Aliased slugs SHALL resolve to their canonical section with the alias's sub-view active, and the URL SHALL keep the alias slug so the deep link stays stable and shareable: `devices` SHALL open `pairing` with the 桌面应用 tab active, `wechat-app` SHALL open `pairing` with the 小程序 tab active, `diagnostics` SHALL open `status` with the 逐回合追踪 tab active, and `skills` SHALL open `mcp` with the skills sub-view active. An alias SHALL NOT introduce a separate section, group membership, or list entry.

Switching sections within the open modal SHALL update the URL to that section's canonical slug, so the browser's back button returns to the previously viewed section, and so the current section can be copied as a link.

When the modal is opened from within the app, the underlying view SHALL be carried as the modal's background location. When a `/settings/:section` URL is loaded directly — a fresh page load, a bookmark, or a deep link — there is no background location, and the modal SHALL render over the `/chat` view.

#### Scenario: deep link opens a section directly

- **WHEN** the user loads `/settings/models` directly in a new browser tab
- **THEN** the Settings modal SHALL open with the Models section active
- **AND** the chat view SHALL render beneath the modal as the background

#### Scenario: bare `/settings` resolves to General

- **WHEN** the user navigates to `/settings`
- **THEN** the router SHALL resolve to `/settings/general`
- **AND** the General section SHALL be active
- **WHEN** the resolved layout hides General
- **THEN** the router SHALL resolve to the first visible section instead

#### Scenario: unknown section falls back to General

- **WHEN** the user navigates to `/settings/nonexistent`
- **THEN** the router SHALL resolve to the first visible section — General under the factory preset
- **AND** the address bar SHALL show that section's canonical slug
- **AND** no error pane SHALL render

#### Scenario: alias slugs open their canonical section with the sub-view active

- **WHEN** the user navigates to `/settings/devices?bindcode=123456`
- **THEN** the Pairing section SHALL be active with the 桌面应用 tab preselected
- **AND** the bind code query parameter SHALL be preserved
- **WHEN** the user navigates to `/settings/wechat-app?bindcode=123456`
- **THEN** the Pairing section SHALL be active with the 小程序 tab preselected
- **WHEN** the user navigates to `/settings/diagnostics`
- **THEN** the System Status section SHALL be active with the 逐回合追踪 tab preselected

#### Scenario: switching sections updates the URL

- **WHEN** the Settings modal is open at `/settings/general` and the user selects the MCP section
- **THEN** the URL SHALL become `/settings/mcp`
- **AND** the MCP section SHALL be active
- **AND** pressing the browser back button SHALL return to `/settings/general` with the General section active

### Requirement: Legacy configuration routes redirect into Settings

The standalone routes that previously hosted configuration pages SHALL redirect to their Settings section equivalents so existing deep links and bookmarks continue to resolve. The redirect SHALL be to one canonical URL per section view; no legacy path SHALL render a section pane at its old URL. Routes for surfaces that left Settings SHALL redirect to that surface's own top-level route instead of a `/settings/*` URL.

| Legacy route | Redirects to |
|---|---|
| `/models` | `/settings/models` |
| `/mcp` | `/settings/mcp` |
| `/skills` | `/settings/skills` |
| `/extensions` | `/settings/mcp` |
| `/extensions/mcp` | `/settings/mcp` |
| `/extensions/skills` | `/settings/skills` |
| `/dashboard` | `/settings/status` |
| `/trace` | `/settings/diagnostics` |
| `/bots` | `/channels` |
| `/settings/channels` | `/channels` |
| `/settings/websearch` | `/settings/connections?panel=search` |
| `/settings/packs` | `/agents` (packs sub-tab, per `agent-catalog`) |
| `/settings/presets` | `/agents` (presets sub-tab, per `agent-catalog`) |

`/trace` SHALL keep resolving to the per-turn trace view, now the 逐回合追踪 tab of the `status` section (`/settings/diagnostics`). `/settings/channels` and `/bots` SHALL leave the Settings modal: both SHALL redirect to the `/channels` nav surface, and neither SHALL open the modal with a Channels section.

#### Scenario: legacy model route redirects

- **WHEN** the user navigates to `/models`
- **THEN** the router SHALL redirect to `/settings/models`
- **AND** the Settings modal SHALL open with the Models section active

#### Scenario: legacy extension routes redirect

- **WHEN** the user navigates to `/mcp`, `/extensions`, or `/extensions/mcp`
- **THEN** the router SHALL redirect to `/settings/mcp`
- **WHEN** the user navigates to `/skills` or `/extensions/skills`
- **THEN** the router SHALL redirect to `/settings/skills`

#### Scenario: legacy dashboard route redirects

- **WHEN** the user navigates to `/dashboard`
- **THEN** the router SHALL redirect to `/settings/status`
- **AND** the Settings modal SHALL open with the System Status section active

#### Scenario: trace route lands on the status diagnostics tab

- **WHEN** the user navigates to `/trace`
- **THEN** the router SHALL redirect to `/settings/diagnostics`
- **AND** the Settings modal SHALL open with the System Status section active and the 逐回合追踪 tab preselected

#### Scenario: channels left Settings and redirects to its nav surface

- **WHEN** the user navigates to `/bots`
- **THEN** the router SHALL redirect to `/channels`
- **WHEN** the user navigates to `/settings/channels`
- **THEN** the router SHALL redirect to `/channels`
- **AND** the Settings modal SHALL NOT open with a Channels section in either case

#### Scenario: demoted surface routes redirect

- **WHEN** the user opens a route whose surface was demoted out of the working views or moved between containers
- **THEN** it SHALL redirect to its canonical home — `/trace` and `/dashboard` into the status section, `/settings/channels` and `/bots` onto the `/channels` nav surface — rather than rendering a pane at the old address

#### Scenario: no legacy path renders a pane at its old URL

- **WHEN** the user navigates to any legacy configuration route
- **THEN** the address bar SHALL show the canonical URL from the table above
- **AND** SHALL NOT remain on the legacy path

### Requirement: Settings sections reuse existing page components unchanged

The Models, Tools & Skills, and System Status sections SHALL render the existing page components for those surfaces; the System Status section's 逐回合追踪 tab SHALL render the existing trace list page component. Their internal controls, behavior, REST calls, and `data-testid` attributes SHALL be unchanged — only the container changes from a full-width page to a modal section pane. The System Status section SHALL mount the health component for its health tab and the trace component for its trace tab, so the merged section mounts no more than the active tab.

Section content SHALL be loaded lazily, so opening the modal mounts only the active section and not all of them. The Pairing section SHALL render the existing desktop-app pairing, paired-device list, and mini-program binding components as its three tabs, keeping their controls, REST calls, and `data-testid` attributes unchanged.

#### Scenario: section content is unchanged from the standalone page

- **WHEN** the user opens the Models section in the Settings modal
- **THEN** the section SHALL render the same controls and `data-testid` attributes the standalone `/models` page rendered
- **AND** the controls SHALL behave identically
- **WHEN** the user opens the 逐回合追踪 tab of System Status
- **THEN** the section SHALL render the same trace list and `data-testid` attributes the former standalone `/trace` page rendered

#### Scenario: only the active section mounts

- **WHEN** the Settings modal opens with one section active
- **THEN** only that section's component SHALL be mounted
- **AND** the other sections SHALL NOT be mounted until selected

#### Scenario: pairing tabs share one component set

- **WHEN** the user switches between the 小程序, 桌面应用, and 机器 tabs of the Pairing section
- **THEN** only the active tab's component SHALL be mounted
- **AND** the mini-program tab SHALL mint its bind code from the same single-use 5-minute endpoint the 桌面应用 tab uses

### Requirement: The WeChat App section carries the binding QR and code

The Settings modal SHALL pair the current account with the WeChat mini program from the 小程序 tab of the `pairing` section, addressed by the alias route `/settings/wechat-app`. For a signed-in user it SHALL mint the single-use 6-digit bind code from the existing `/api/mp/bindcode` endpoint and present BOTH forms side by side: the numeric code for manual entry and a QR encoding of `<origin>/settings/wechat-app?bindcode=<code>`, so one secret serves scan and type alike. The QR SHALL be rendered client-side (no image upload, no new server route) and SHALL re-render on refresh. The section SHALL state the code's validity (single use, 5 minutes) and that scanning happens in the mini program's login page （扫码绑定）, and SHALL state that the 桌面应用 and 机器 tabs draw from the same code pool. Manual refresh SHALL always be available; expiry after refresh SHALL be discoverable by the user (a visible timer or re-mint on refresh). On a deployment where the endpoint is absent or unauthenticated, the tab SHALL degrade to an explanatory hint rather than an error, and SHALL NOT block the rest of Settings.

#### Scenario: the section shows code and QR together

- **WHEN** a signed-in user opens Settings → 配对与绑定 → 小程序 (or `/settings/wechat-app`)
- **THEN** a freshly minted 6-digit code and a QR encoding `<origin>/settings/wechat-app?bindcode=<code>` are both visible
- **AND** the QR decodes to exactly that URL

#### Scenario: scanning the QR opens the preselected tab

- **WHEN** the mini program scans the QR and the user opens the encoded URL
- **THEN** the Settings modal SHALL open the Pairing section with the 小程序 tab preselected
- **AND** the scanned code SHALL be shown for confirmation

#### Scenario: refresh re-mints

- **WHEN** the user taps the refresh affordance
- **THEN** a new single-use code is minted and both the digits and the QR update

#### Scenario: degraded on deployments without the endpoint

- **WHEN** the tab renders where `/api/mp/bindcode` is unavailable
- **THEN** it shows an explanatory hint and no broken controls
- **AND** the other Settings sections remain fully usable
