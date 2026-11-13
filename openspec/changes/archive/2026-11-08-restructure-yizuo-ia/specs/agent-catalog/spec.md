## MODIFIED Requirements

### Requirement: Agents & Apps page is a top-level route with sub-tabs

The `/agents` route SHALL remain a top-level page (no parent shell) and SHALL keep the slug `agents` and the route `/agents` — the slug is public API and SHALL NOT change. The page SHALL be the 智能体市场 (Agent Market) surface, a nav surface of the 构建 family (per `app-navigation`), and it SHALL be the product's single in-product pack doorway; `/packs` redirects into its matching tab (per `pack-marketplace`).

The page SHALL render exactly two sub-tabs — **市场（Market）** and **我的（Mine）** — with a stable `?tab=` query parameter for deep-linking whose values SHALL be `market` (市场) and `mine` (我的). No third sub-tab SHALL exist on this surface. The 市场 sub-tab SHALL host the pack marketplace's browse / inspect / subscribe surfaces (governed by `pack-marketplace`). The 我的 sub-tab SHALL host the user's own pack state in two sections — 已安装 (installed snapshots, updates, uninstall) and 我的创作 (creator drafts and publish) — with the preset-conversion handoff landing on the 我的创作 section. Subscription, upgrade, uninstall, draft, and publish behavior SHALL be preserved exactly as governed by `pack-marketplace` and `pack-installation`; only the surface and route container moves.

The tab set SHALL be rendered from the unified surface registry resolved through the layout chain (per `layout-configuration`): the `agentsTabs` container SHALL carry exactly `market` and `mine`, both listed by every factory preset, with the 市场 tab's pack-marketplace gating expressed as a platform predicate on its registry entry; layout resolution may hide or reorder tabs within the same bounds (never defeating a platform predicate). The tuning surface SHALL NOT be a tab of this surface: `/tuning` is its own nav surface in the 构建 family, and `tuning` SHALL NOT be added to the `agentsTabs` container.

Retired tab slugs SHALL stay resolvable through the surface-slug aliases rather than by keeping retired tabs in the tab set: `agents` → `mine`, `creations` → `mine`, `supply` → `market`, and `apps` → `market` (the legacy Apps tab content lives in the app center, openspec: app-center). The former Experts sub-tab SHALL be retired from this surface — the page SHALL NOT render an expert roster — and its legacy `agents` slug SHALL resolve to `mine` through the alias above. An aliased or otherwise absent `?tab=` value SHALL fall back to the first visible sub-tab rather than rendering an error.

The 市场 sub-tab SHALL render only on deployments that report the pack marketplace (the platform predicate); on deployments without it the tab SHALL be absent while the 我的 sub-tab still renders, because installed snapshots and creator drafts are local state — so the surface never presents a tab with nothing to connect to, and never loses the user's local pack management.

Sub-tab selection SHALL persist in the URL. On initial load with no query parameter, the first visible sub-tab SHALL be active (市场 under the factory preset). The retired Settings section routes SHALL keep resolving: `/settings/packs` to `/agents?tab=mine`, and `/settings/presets` to its existing destination — the creations/drafts area, which now lives in the 我的 sub-tab — so existing deep links keep resolving.

#### Scenario: default to the market sub-tab

- **WHEN** the user opens `/agents` with no `?tab` parameter under the factory preset
- **THEN** the 市场 sub-tab SHALL be active and the marketplace browse/list surfaces SHALL be visible

#### Scenario: default to Agents sub-tab

- **WHEN** the user opens `/agents` with no `?tab` parameter under the factory preset
- **THEN** the first visible sub-tab SHALL be active — 市场 under the factory preset
- **AND** the former Experts-roster default SHALL no longer apply to this surface

#### Scenario: deep-link to the mine sub-tab

- **WHEN** the user navigates to `/agents?tab=mine` on a marketplace deployment
- **THEN** the 我的 sub-tab SHALL be active, with 已安装 and 我的创作 both rendered

#### Scenario: deep-link to Market

- **WHEN** the user navigates to `/agents?tab=market` on a marketplace deployment
- **THEN** the 市场 sub-tab SHALL be active and the browse/list surfaces SHALL be visible

#### Scenario: deep-link to Apps

- **WHEN** the user navigates to `/agents?tab=apps`
- **THEN** the 市场 sub-tab SHALL be active, no Apps sub-tab SHALL render, and the app-center content SHALL remain at `/apps` (per `app-center`)

#### Scenario: retired tab slugs resolve through the surface-slug aliases

- **WHEN** the user navigates to `/agents?tab=agents`, `/agents?tab=creations`, `/agents?tab=supply`, or `/agents?tab=apps`
- **THEN** `agents` and `creations` SHALL resolve to the 我的 sub-tab, and `supply` and `apps` SHALL resolve to the 市场 sub-tab
- **AND** no retired tab SHALL render as a selectable sub-tab, and no expert roster or app entry list SHALL render on this surface

#### Scenario: 我的 contains installed and creations

- **WHEN** the user opens the 我的 sub-tab
- **THEN** installed packs with versions and update affordances render under 已安装, and the user's drafts with publish affordances render under 我的创作
- **AND** the preset-conversion handoff lands on 我的创作

#### Scenario: tab selection persists across reloads

- **WHEN** the user selects the 我的 sub-tab and reloads the page
- **THEN** the URL SHALL carry `?tab=mine` and the 我的 sub-tab SHALL be active on load

#### Scenario: resolved layout hides a sub-tab

- **WHEN** the resolved layout for a user omits the 市场 sub-tab
- **THEN** the page renders without the 市场 tab, a `?tab=market` deep link falls back to the first visible sub-tab, and no error surfaces

#### Scenario: first visible tab active on narrowed presets

- **WHEN** the resolved layout hides the 市场 tab (e.g. a mine-only preset) and the user opens `/agents` without a parameter
- **THEN** the first visible sub-tab (我的) SHALL be active

#### Scenario: Market tab is absent without a marketplace

- **WHEN** the deployment does not report the pack marketplace
- **THEN** the page SHALL render the 我的 sub-tab alone with installed packs and creator drafts
- **AND** `/agents?tab=market` SHALL fall back to the 我的 sub-tab
- **AND** no empty market shell SHALL render

#### Scenario: 调优 is not a tab of the market surface

- **WHEN** the user opens `/agents` and inspects its sub-tabs
- **THEN** no 调优 tab SHALL be present, and `/tuning` SHALL render as its own nav surface in the 构建 family

#### Scenario: retired Settings sections redirect into the page

- **WHEN** the user navigates to `/settings/packs` or `/settings/presets`
- **THEN** both SHALL redirect to `/agents?tab=mine` — the former opening 已安装, the latter its existing destination, the 我的创作 area — so existing deep links keep resolving
