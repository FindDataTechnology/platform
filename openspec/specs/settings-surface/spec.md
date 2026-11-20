# settings-surface Specification

## Purpose

Defines the in-app Settings modal: a single overlay surface that hosts the application's configuration sections (General, Account, WeChat App, Paired devices, Connections, Tools & Skills, Models, User roles, Workbench layout, Channels, Diagnostics, System Status, Deployment branding), its `/settings/:section` routing and deep-link behavior, its open and dismiss affordances, and the redirects that retire the former standalone configuration pages.

## Requirements

### Requirement: Settings modal surface

The web UI SHALL provide a Settings modal that overlays the current view rather than replacing it. The modal SHALL organize its sections into three stable groups, in order — **Basics（常规）**, **Capabilities（能力）**, **Management（管理）** — holding exactly ten sections:

- Basics（常规）: **General（通用）**, **Account（账户）**, **Pairing（配对与绑定）**
- Capabilities（能力）: **Connections（连接）**, **Models（模型）**
- Management（管理）: **User roles（用户角色）**, **Workbench layout（工作面布局）**, **Delegation（委托策略）**, **Deployment branding（部署品牌）**, **System Status（系统状态）**

Each section SHALL be identified by a stable slug which forms part of its URL and SHALL NOT change: `general`, `account`, `pairing`, `connections`, `models`, `roles`, `layout`, `delegation`, `branding`, `status`.

`pairing` SHALL be the single section that binds the current account to external clients, and SHALL present three internal tabs — 小程序 (mini program), 桌面应用 (desktop app), 机器 (machine) — because all three mint from the same single-use 5-minute bind-code pool. The retired `devices` and `wechat-app` slugs SHALL remain addressable as aliases of `pairing` and SHALL open it with the corresponding tab preselected (`devices` → 桌面应用, `wechat-app` → 小程序); they SHALL NOT be separate sections. Their deep links, including `/settings/devices?bindcode=<code>` and `/settings/wechat-app?bindcode=<code>`, SHALL keep working and SHALL keep preselecting their tab.

The former `channels` section SHALL leave the Settings modal entirely and become a nav surface at `/channels` (per `app-navigation` and `social-bot-channels`); `/settings/channels` and `/bots` SHALL redirect to `/channels`, and the bots management page SHALL no longer render inside the modal. The former `diagnostics` section SHALL be merged into `status` as a tab (状态 = 健康 + 逐回合追踪); the `diagnostics` slug SHALL remain addressable as an alias of `status` opening the per-turn trace tab, and `/trace` SHALL keep redirecting there.

The former `websearch` section is retired as a rendered section; its `/settings/websearch` URL SHALL redirect to `/settings/connections?panel=search` (per `connection-center`) so existing deep links keep resolving — the slug remains stably addressable through this redirect rather than as a section pane. The former Tools & Skills section and its `skills` address, and the former Plugins section and its `plugins` address, SHALL leave the Settings modal entirely, because the capability markets are work surfaces and not configuration: `/settings/mcp`, `/settings/skills`, and `/settings/plugins` SHALL be route-level redirects to the 工具, 技能, and 插件 tabs of the 素材市场 surface at `/agents` (per `app-navigation`), and SHALL NOT open the Settings modal with any section active. They SHALL NOT be section aliases: an alias opens the modal on a canonical section, and the modal must not open at all here. `models` SHALL NOT leave: models are configuration, not a marketplace, so the Models section stays a plain Settings section. The former `packs` and `presets` sections are retired from Settings; their `/settings/packs` and `/settings/presets` URLs redirect to the corresponding `/agents` sub-tabs (per `agent-catalog`). Section labels SHALL resolve from the internationalization resource bundle keyed by the stable slug, so the label follows the active locale while the slug, ordering, and icon remain stable; user-facing zh-CN copy SHALL use user-language terms (连接, 模型, 用户角色, 工作面布局, 委托策略, 部署品牌) and SHALL NOT surface developer vocabulary such as "MCP" in section labels.

The modal SHALL present an in-modal search field above the section list that filters the sections by their label text in the active locale. Filtering SHALL be client-side, over the already-resolved list, and SHALL NOT bypass resolved-layout hiding, section predicates, or the admin-only rules: a section hidden by layout or predicate SHALL NOT become visible because its label matches the query. With an empty query the list SHALL render unchanged; a query that matches no section SHALL render an explicit no-match line rather than an empty pane.

The modal SHALL be dismissible and SHALL restore the user to the view they opened it from, with that view's scroll position preserved.

The **User roles** and **Workbench layout** sections SHALL be admin-only when auth is on and visible to everyone when auth is off, matching the server-side gates on their routes (per `role-system` and `layout-configuration`).

The rendered section list SHALL honor the resolved layout for the user (per `layout-configuration`): the factory preset renders the full canonical list above; a narrower preset hides sections, and deployment-hiding is terminal.

The rendered section list SHALL be generated only from registry-resolved slugs: every section the modal can render SHALL exist in the `settings` surface registry, and every settings section definition SHALL be registered. A section definition absent from the registry SHALL NOT be silently dropped from the modal without a test-visible failure — the section definitions and the surface registry SHALL agree, so a section cannot exist in one place and not the other. That agreement SHALL hold over exactly the ten canonical sections above: `mcp`, `skills`, and `plugins` SHALL NOT appear on either side, because they are redirects into the market rather than sections.

A section's declared group SHALL agree with its position in the canonical section list: members of a group SHALL be listed contiguously, and the modal SHALL render a group heading exactly once per group, at the group's first visible member. A group with no visible member SHALL render no heading.

#### Scenario: modal overlays the current view

- **WHEN** the user opens Settings from the chat view
- **THEN** the Settings modal SHALL render above the chat view
- **AND** the chat view SHALL remain mounted beneath the modal
- **AND** the chat view SHALL NOT be unmounted or remounted

#### Scenario: canonical section set and ordering

- **WHEN** the Settings modal renders for an admin (or auth is off) under the factory preset
- **THEN** it SHALL present exactly ten sections in three groups, Basics, Capabilities, Management, in that order: General, Account, Pairing; Connections, Models; User roles, Workbench layout, Delegation, Deployment branding, System Status
- **AND** each section label SHALL be resolved from the i18n bundle under a stable key
- **AND** the section slugs, grouping, and ordering SHALL NOT change when the active locale changes
- **AND** no Packs, Custom presets, Channels, or Diagnostics section SHALL be present
- **AND** no Tools & Skills, MCP, Skills, or Plugins section SHALL be present
- **AND** the Models section SHALL be present
- **AND** each group heading SHALL appear exactly once, at the first section of its group

#### Scenario: group membership agrees with list position

- **WHEN** the modal renders the section list in canonical order
- **THEN** consecutive sections with different declared groups SHALL be exactly the group boundaries, so each of Basics, Capabilities, Management is listed contiguously
- **AND** no group heading SHALL be re-emitted after the list has moved past that group
- **AND** a section whose declared group disagrees with its position SHALL fail the settings registry test rather than render an interleaved heading

#### Scenario: every section definition is registry-resolved

- **WHEN** the settings section definitions are compared with the `settings` entries of the surface registry
- **THEN** the two sets of canonical slugs SHALL be equal, and each SHALL contain exactly the ten slugs general, account, pairing, connections, models, roles, layout, delegation, branding, status
- **AND** a slug present in one and absent from the other SHALL fail a test-visible check
- **AND** `mcp`, `skills`, and `plugins` SHALL be absent from both sets
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

Aliased slugs SHALL resolve to their canonical section with the alias's sub-view active, and the URL SHALL keep the alias slug so the deep link stays stable and shareable: `devices` SHALL open `pairing` with the 桌面应用 tab active, `wechat-app` SHALL open `pairing` with the 小程序 tab active, and `diagnostics` SHALL open `status` with the 逐回合追踪 tab active. An alias SHALL NOT introduce a separate section, group membership, or list entry.

The retired capability slugs are NOT section aliases: `mcp`, `skills`, and `plugins` SHALL be intercepted at the route level and redirected to the 工具, 技能, and 插件 tabs of the 素材市场 surface at `/agents` (per `app-navigation`), so the Settings modal SHALL NOT open for them. An alias by definition opens the modal on a canonical section; these three must not, because their surface is a market, not a preference pane. Accordingly they SHALL NOT appear in the section list, SHALL NOT resolve as the first-visible-section fallback, and SHALL NOT be counted among the ten canonical slugs.

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

- **WHEN** the Settings modal is open at `/settings/general` and the user selects the Models section
- **THEN** the URL SHALL become `/settings/models`
- **AND** the Models section SHALL be active
- **AND** pressing the browser back button SHALL return to `/settings/general` with the General section active

### Requirement: Settings modal open and dismiss affordances

The Settings modal SHALL be openable from a gear control in the sidebar footer and by the keyboard shortcut `Cmd + ,` on macOS / `Ctrl + ,` on other platforms. The shortcut SHALL be active from any view in the application.

The modal SHALL be dismissible by pressing `Escape`, by clicking the backdrop outside the modal, and by activating an explicit close control. Every dismissal path SHALL navigate back to the background location rather than leaving a `/settings/*` URL in the address bar.

While the modal is open, focus SHALL be trapped within it, and on close focus SHALL return to the control that opened it.

#### Scenario: keyboard shortcut opens Settings from any view

- **WHEN** the user is on any view and presses `Cmd + ,` (macOS) or `Ctrl + ,` (other platforms)
- **THEN** the Settings modal SHALL open
- **AND** the URL SHALL become a `/settings/:section` route

#### Scenario: gear control opens Settings

- **WHEN** the user activates the gear control in the sidebar footer
- **THEN** the Settings modal SHALL open

#### Scenario: Escape dismisses and restores the URL

- **WHEN** the Settings modal is open over `/chat/abc123` and the user presses `Escape`
- **THEN** the modal SHALL close
- **AND** the URL SHALL return to `/chat/abc123`

#### Scenario: backdrop click dismisses

- **WHEN** the Settings modal is open and the user clicks the backdrop outside the modal panel
- **THEN** the modal SHALL close
- **AND** the URL SHALL return to the background location

#### Scenario: focus is trapped and restored

- **WHEN** the Settings modal is open
- **THEN** keyboard focus SHALL remain within the modal
- **AND** when the modal closes, focus SHALL return to the control that opened it

### Requirement: Legacy configuration routes redirect into Settings

The standalone routes that previously hosted configuration pages SHALL redirect to their Settings section equivalents so existing deep links and bookmarks continue to resolve. The redirect SHALL be to one canonical URL per section view; no legacy path SHALL render a section pane at its old URL. Routes for surfaces that left Settings SHALL redirect to that surface's own top-level route instead of a `/settings/*` URL.

| Legacy route | Redirects to |
|---|---|
| `/models` | `/settings/models` |
| `/mcp` | `/agents?tab=tools` |
| `/skills` | `/agents?tab=skills` |
| `/extensions` | `/agents?tab=tools` |
| `/extensions/mcp` | `/agents?tab=tools` |
| `/extensions/skills` | `/agents?tab=skills` |
| `/settings/mcp` | `/agents?tab=tools` |
| `/settings/skills` | `/agents?tab=skills` |
| `/settings/plugins` | `/agents?tab=plugins` |
| `/dashboard` | `/settings/status` |
| `/trace` | `/settings/diagnostics` |
| `/bots` | `/channels` |
| `/settings/channels` | `/channels` |
| `/settings/websearch` | `/settings/connections?panel=search` |
| `/settings/packs` | `/agents` (agents sub-tab, per `agent-catalog`) |
| `/settings/presets` | `/agents` (agents sub-tab, per `agent-catalog`) |

`/trace` SHALL keep resolving to the per-turn trace view, now the 逐回合追踪 tab of the `status` section (`/settings/diagnostics`). `/settings/channels` and `/bots` SHALL leave the Settings modal: both SHALL redirect to the `/channels` nav surface, and neither SHALL open the modal with a Channels section. `/settings/mcp`, `/settings/skills`, and `/settings/plugins` SHALL likewise leave the Settings modal: each SHALL redirect to the corresponding tab of the 素材市场 surface, and none SHALL open the modal at all.

#### Scenario: legacy model route redirects

- **WHEN** the user navigates to `/models`
- **THEN** the router SHALL redirect to `/settings/models`
- **AND** the Settings modal SHALL open with the Models section active

#### Scenario: legacy extension routes redirect

- **WHEN** the user navigates to `/mcp`, `/extensions`, or `/extensions/mcp`
- **THEN** the router SHALL redirect to the 工具 tab of the 素材市场 surface at `/agents`
- **WHEN** the user navigates to `/skills` or `/extensions/skills`
- **THEN** the router SHALL redirect to the 技能 tab of the 素材市场 surface at `/agents`

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
- **THEN** it SHALL redirect to its canonical home — `/trace` and `/dashboard` into the status section, `/settings/channels` and `/bots` onto the `/channels` nav surface, and `/settings/mcp`, `/settings/skills`, and `/settings/plugins` onto the matching tab of the 素材市场 surface — rather than rendering a pane at the old address

#### Scenario: no legacy path renders a pane at its old URL

- **WHEN** the user navigates to any legacy configuration route
- **THEN** the address bar SHALL show the canonical URL from the table above
- **AND** SHALL NOT remain on the legacy path

### Requirement: Settings sections reuse existing page components unchanged

The Models and System Status sections SHALL render the existing page components for those surfaces; the System Status section's 逐回合追踪 tab SHALL render the existing trace list page component. Their internal controls, behavior, REST calls, and `data-testid` attributes SHALL be unchanged — only the container changes from a full-width page to a modal section pane. The System Status section SHALL mount the health component for its health tab and the trace component for its trace tab, so the merged section mounts no more than the active tab. The 工具 and 技能 views that the modal used to host are not Settings sections any more: they SHALL render unchanged inside the 工具 and 技能 tabs of the 素材市场 surface, keeping their controls, REST calls, and `data-testid` attributes.

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

### Requirement: General section hosts appearance and language preferences

The General section SHALL host the theme control and the locale control. These are the two preferences that previously had no home or occupied permanent space in the sidebar footer.

#### Scenario: General section presents theme and language

- **WHEN** the user opens the General section
- **THEN** the section SHALL present a theme control offering light, dark, and system
- **AND** the section SHALL present a locale control listing the supported locales

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

### Requirement: Retired capability slugs redirect into the materials market without opening the modal

The `/settings/mcp`, `/settings/skills`, and `/settings/plugins` URLs SHALL NOT resolve to a Settings section. Each SHALL be handled as a route-level redirect to the matching tab of the 素材市场 surface at `/agents` — 工具, 技能, and 插件 respectively — and the Settings modal SHALL NOT open. This SHALL be a redirect rather than a section alias, because an alias is defined to open the modal on a canonical section and these three have no canonical section to open.

#### Scenario: tools URL lands on the market tools tab

- **WHEN** the user navigates to `/settings/mcp`
- **THEN** the router SHALL redirect to the 工具 tab of the `/agents` surface
- **AND** the Settings modal SHALL NOT open
- **AND** the address bar SHALL show the market route, not a `/settings/*` URL

#### Scenario: skills URL lands on the market skills tab

- **WHEN** the user navigates to `/settings/skills`
- **THEN** the router SHALL redirect to the 技能 tab of the `/agents` surface
- **AND** the Settings modal SHALL NOT open

#### Scenario: plugins URL lands on the market plugins tab

- **WHEN** the user navigates to `/settings/plugins`
- **THEN** the router SHALL redirect to the 插件 tab of the `/agents` surface
- **AND** the Settings modal SHALL NOT open
- **AND** no Plugins section SHALL be listed or resolvable inside the modal
