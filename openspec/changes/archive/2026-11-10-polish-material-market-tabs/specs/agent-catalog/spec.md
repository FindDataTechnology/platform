## MODIFIED Requirements

### Requirement: Agents & Apps page is a top-level route with sub-tabs

The `/agents` route SHALL remain a top-level page (no parent shell) and SHALL keep the slug `agents` and the route `/agents` — the slug is public API and SHALL NOT change. The page SHALL be the 素材市场 (Material Market) surface, a nav surface of the 构建 family (per `app-navigation`), and it SHALL carry the product's material markets. It remains the product's single in-product pack doorway: `/packs` redirects into its 智能体 tab (per `pack-marketplace`).

The page SHALL render exactly five sub-tabs, in the unified surface registry's `agentsTabs` order — **智能体（Agents）**, **工具（Tools）**, **技能（Skills）**, **插件（Plugins）**, **我的（Mine）** — with a stable `?tab=` query parameter for deep-linking whose values SHALL be exactly those five slugs in that order: `agents`, `tools`, `skills`, `plugins`, `mine`. No sixth sub-tab SHALL exist on this surface, and the retired single browse tab SHALL NOT return as one.

Each sub-tab SHALL host exactly its species' content: the 智能体 (`agents`) sub-tab SHALL host the pack marketplace's browse / inspect / subscribe surfaces (governed by `pack-marketplace`); the 工具 (`tools`) sub-tab SHALL host the MCP market shelf plus the installed-server roster — list, add, edit, remove, and enable/disable — with credential connect cards remaining in the Settings connections section (per `extension-management-ui`, `connection-center`); the 技能 (`skills`) sub-tab SHALL host the skill market shelf including its external-source zone, plus the installed-skill roster and the user's skill candidates; the 插件 (`plugins`) sub-tab SHALL host the plugin catalogue with its three supply states — 可启用（supplied with the deployment or desktop build; one enable toggle）、未供应（visible in the catalogue and marked 申请供应）、已启用 — with a per-entry enable toggle and the 申请供应 request affordance (per `dsh-plugin-supply`, `plugin-supply-request`); and the 我的 (`mine`) sub-tab SHALL host the user's own pack state unchanged, in two sections — 已安装 (installed snapshots, updates, uninstall) and 我的创作 (creator drafts and publish) — with the preset-conversion handoff landing on the 我的创作 section. Subscription, upgrade, uninstall, draft, publish, add, edit, remove, install, toggle, and request-supply behavior SHALL be preserved exactly as governed by their own capabilities; only the surface and route container moves.

The tab set SHALL be rendered from the unified surface registry resolved through the layout chain (per `layout-configuration`): the `agentsTabs` container SHALL carry exactly `agents`, `tools`, `skills`, `plugins`, and `mine`, all listed by every factory preset, with NO tab carrying a marketplace predicate — the `agents` entry is the market's front page and SHALL be present on every deployment; `tools`, `skills`, and `plugins` SHALL likewise always be present, and an empty plugin catalogue SHALL still render its tab with its explanation. Layout resolution may hide or reorder tabs within the same bounds (never defeating a platform predicate). The tuning surface SHALL NOT be a tab of this surface: `/tuning` is its own nav surface in the 构建 family, and `tuning` SHALL NOT be added to the `agentsTabs` container.

Retired sub-tab slugs SHALL stay resolvable through the surface-slug aliases rather than by keeping retired tabs in the tab set: `market` → `agents` (the retired browse tab), `supply` → `agents`, `apps` → `agents` (the legacy Apps tab content lives in the app center, openspec: app-center), `build` → `agents`, and `creations` → `mine`. `agents` SHALL NOT be aliased any more: it is a canonical sub-tab slug. Stale pre-rename links SHALL NOT dead-end or error: `/packs` and `/packages`-style legacy paths SHALL redirect into `/agents?tab=agents`, and an aliased or otherwise unknown `?tab=` value SHALL fall back to the first visible sub-tab rather than rendering an error. The former Experts sub-tab SHALL remain retired — the page SHALL NOT render an expert roster.

The 智能体 sub-tab SHALL render on EVERY deployment. Where the deployment reports no pack marketplace it SHALL render an honest unavailable state — naming that this deployment carries no marketplace and pointing at 我的 for packs already installed (they keep working) — instead of disappearing: a vanished front page opened the surface on 工具 and read as if the market had been removed, which is a worse answer than saying what is true. The 我的 sub-tab keeps local pack management regardless.

Sub-tab selection SHALL persist in the URL. On initial load with no query parameter the 智能体 sub-tab SHALL be active, on every deployment. The retired Settings section routes SHALL keep resolving: `/settings/packs` to `/agents?tab=mine`, and `/settings/presets` to its existing destination — the creations/drafts area, which now lives in the 我的 sub-tab — so existing deep links keep resolving. The retired capability routes SHALL likewise land on their tabs, as owned by `settings-surface`: `/settings/mcp`, `/mcp`, `/extensions`, and `/extensions/mcp` to `/agents?tab=tools`, and `/settings/skills`, `/skills`, and `/extensions/skills` to `/agents?tab=skills`.

The page's own chrome SHALL be built from the foundation primitives rather than hand-rolled: the header SHALL be a `PageShell` (title as the first reading point, actions right-anchored), and the sub-tab strip SHALL be the foundation `Tabs` (single keyboard contract: arrows move selection, Home/End jump to the ends, roving tab index, `aria-selected` on the active tab). The strip's active state MUST NOT be drawn with a coloured border of two pixels or more. This changes paint and keyboard semantics only: the sub-tab slugs, their order, and the `agent-market-tab-<slug>` / `agent-market-panel-<slug>` / `agent-market-page` test ids SHALL remain exactly as specified above, because they are asserted by e2e and act as public API.

The 智能体 sub-tab's cards SHALL state the viewer's relation to each material: a card whose pack has a local installed snapshot SHALL show 已装 with that snapshot's version, and a card whose listed version is newer than the installed snapshot SHALL show 可更新 with the newer version. Both SHALL carry their meaning in words via the status vocabulary, not by colour alone. When either side of the comparison is unavailable — no installed snapshot read, or no listed version — the card SHALL show neither state rather than guessing. This state is informational: it MUST NOT open a sixth sub-tab, alter the `?tab=` contract, gate subscribe or install, or replace the 我的 sub-tab's own installed/update affordances.

#### Scenario: default to the market sub-tab

- **WHEN** the user opens `/agents` with no `?tab` parameter under the factory preset
- **THEN** the 智能体 sub-tab SHALL be active and the marketplace browse/list surfaces SHALL be visible

#### Scenario: default to Agents sub-tab

- **WHEN** the user opens `/agents` with no `?tab` parameter under the factory preset
- **THEN** the first visible sub-tab SHALL be active — 智能体 under the factory preset
- **AND** the former two-tab default SHALL no longer apply, the 智能体 tab being the market's first species in registry order

#### Scenario: sub-tabs are exactly the five species in registry order

- **WHEN** the user opens `/agents` on a marketplace deployment and inspects its sub-tabs
- **THEN** the tabs SHALL be 智能体, 工具, 技能, 插件, 我的, in that order
- **AND** each tab's `?tab=` value SHALL be `agents`, `tools`, `skills`, `plugins`, `mine` respectively
- **AND** no other sub-tab SHALL render

#### Scenario: tools tab carries the MCP shelf and the installed roster

- **WHEN** the user opens `/agents?tab=tools`
- **THEN** the MCP market shelf and the installed-server roster SHALL render in that tab, with their add, edit, remove, and toggle affordances
- **AND** no credential connect card SHALL render in the shelf — the connect cards remain in the Settings connections section

#### Scenario: skills tab carries the shelf, the external zone, and the installed roster

- **WHEN** the user opens `/agents?tab=skills`
- **THEN** the skill market shelf with its external-source zone, the installed-skill roster, and the user's skill candidates SHALL render in that tab
- **AND** installing an external skill SHALL still pass through its consent panel before anything is installed

#### Scenario: plugins tab carries the three supply states

- **WHEN** the user opens `/agents?tab=plugins`
- **THEN** the catalogue SHALL mark each supplied bundle 可启用 unless already enabled, show 已启用 for an enabled bundle, and mark a catalogue entry the deployment does not supply 未供应 with a 申请供应 action
- **AND** a supplied bundle's enable toggle SHALL apply through the plugin-supply bridge
- **AND** when the deployment supplies nothing, the tab SHALL still render with the catalogue's explanation

#### Scenario: deep-link to the mine sub-tab

- **WHEN** the user navigates to `/agents?tab=mine` on a marketplace deployment
- **THEN** the 我的 sub-tab SHALL be active, with 已安装 and 我的创作 both rendered

#### Scenario: deep-link to Market

- **WHEN** the user navigates to `/agents?tab=market` on a marketplace deployment
- **THEN** the value SHALL normalize to `agents`, the 智能体 sub-tab SHALL be active, and the browse/list surfaces SHALL be visible

#### Scenario: deep-link to Apps

- **WHEN** the user navigates to `/agents?tab=apps`
- **THEN** the 智能体 sub-tab SHALL be active, no Apps sub-tab SHALL render, and the app-center content SHALL remain at `/apps` (per `app-center`)

#### Scenario: retired tab slugs resolve through the surface-slug aliases

- **WHEN** the user navigates to `/agents?tab=creations`, `/agents?tab=supply`, `/agents?tab=apps`, or `/agents?tab=build`
- **THEN** `creations` SHALL resolve to the 我的 sub-tab, and `supply`, `apps`, and `build` SHALL resolve to the 智能体 sub-tab
- **AND** `?tab=agents` SHALL be the canonical value selecting the 智能体 sub-tab, not an alias
- **AND** no retired tab SHALL render as a selectable sub-tab, and no expert roster or app entry list SHALL render on this surface

#### Scenario: stale packages links land on the agents tab

- **WHEN** the user follows a `/packages`-style stale link (or the older `/packs` pathway)
- **THEN** the router SHALL resolve to `/agents?tab=agents` without an error page, and the 智能体 sub-tab SHALL be active

#### Scenario: 我的 contains installed and creations

- **WHEN** the user opens the 我的 sub-tab
- **THEN** installed packs with versions and update affordances render under 已安装, and the user's drafts with publish affordances render under 我的创作
- **AND** the preset-conversion handoff lands on 我的创作

#### Scenario: tab selection persists across reloads

- **WHEN** the user selects the 我的 sub-tab and reloads the page
- **THEN** the URL SHALL carry `?tab=mine` and the 我的 sub-tab SHALL be active on load

#### Scenario: resolved layout hides a sub-tab

- **WHEN** the resolved layout for a user omits the 智能体 sub-tab
- **THEN** the page renders without the 智能体 tab, a `?tab=agents` deep link falls back to the first visible sub-tab, and no error surfaces

#### Scenario: first visible tab active on narrowed presets

- **WHEN** the resolved layout hides the 智能体 tab (e.g. a mine-only preset) and the user opens `/agents` without a parameter
- **THEN** the first visible sub-tab SHALL be active — 工具 under a five-species preset, 我的 under a mine-only preset

#### Scenario: Market tab is absent without a marketplace

- **WHEN** the deployment does not report the pack marketplace
- **THEN** the page SHALL render all five sub-tabs, 智能体 first and active by default (the tab is not absent any more — its CONTENT is),
- **AND** the 智能体 panel SHALL state that this deployment carries no marketplace and SHALL point at 我的 for already-installed packs
- **AND** no empty market shell (a marketplace browse surface with nothing behind it) SHALL render

#### Scenario: 调优 is not a tab of the market surface

- **WHEN** the user opens `/agents` and inspects its sub-tabs
- **THEN** no 调优 tab SHALL be present among the five species, and `/tuning` SHALL render as its own nav surface in the 构建 family

#### Scenario: retired Settings sections redirect into the page

- **WHEN** the user navigates to `/settings/packs` or `/settings/presets`
- **THEN** both SHALL redirect to `/agents?tab=mine` — the former opening 已安装, the latter its existing destination, the 我的创作 area — so existing deep links keep resolving
- **WHEN** the user navigates to `/settings/mcp`, `/settings/skills`, or `/settings/plugins`
- **THEN** each SHALL redirect to `/agents?tab=tools`, `/agents?tab=skills`, and `/agents?tab=plugins` respectively (per `settings-surface`)

#### Scenario: an installed material says so on its card

- **WHEN** the user opens the 智能体 sub-tab and one listed pack has a local installed snapshot at v3
- **THEN** that pack's card shows 已装 v3 in words, and packs without a snapshot show no installed state at all

#### Scenario: an available update says so on its card

- **WHEN** a listed pack is published at v4 while the local snapshot sits at v3
- **THEN** the card shows 可更新 v4, and the 我的 sub-tab's own update affordance is unchanged

#### Scenario: missing state is not guessed

- **WHEN** the installed-snapshot read fails or a card carries no listed version
- **THEN** the card shows neither 已装 nor 可更新, and the market still renders its rows

#### Scenario: the relation state gates nothing

- **WHEN** a pack is already installed at the latest version and the user subscribes or installs it again
- **THEN** the action proceeds through its normal gate — the card state never blocks or auto-triggers it

#### Scenario: the tab strip keeps its keyboard contract

- **WHEN** the user focuses the sub-tab strip and presses ArrowRight, ArrowLeft, Home, or End
- **THEN** selection moves per the foundation `Tabs` contract and the URL updates to the newly selected `?tab=` value

#### Scenario: the strip's test ids and slugs are unchanged

- **WHEN** the sub-tab strip renders after the chrome change
- **THEN** `agent-market-page`, `agent-market-tab-<slug>` and `agent-market-panel-<slug>` are present exactly as before, with the same five slugs
