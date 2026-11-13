## MODIFIED Requirements

### Requirement: Agents & Apps page is a top-level route with sub-tabs

The `/agents` route SHALL be a top-level page (replacing the legacy location; no parent shell). The page SHALL render two sub-tabs — **Experts（专家）** and **Packs（功能集）** — with a stable `?tab=` query parameter for deep-linking whose values SHALL be `agents` (Experts) and `market` (Packs); the legacy `apps` value SHALL fall back to the first visible tab (the Apps sub-tab is retired — its entries move to the app center, openspec: app-center). The tab set SHALL be rendered from the unified surface registry resolved through the layout chain (per `layout-configuration`): the factory preset shows both tabs, with the Packs tab's pack-marketplace gating expressed as a platform predicate on its registry entry; layout resolution may hide or reorder tabs within the same bounds (never defeating a platform predicate). The `apps` tab slug SHALL remain in the registry for stored-layout compatibility while being excluded from every factory preset.

The Experts sub-tab SHALL present the unified expert roster: `agent-local` and `agent-remote` entries from all catalog sources (built-in, cloud, registry, installed packs) alongside the cell's custom presets and the cluster management section (openspec: agent-cluster-core), with custom-preset entries offering inline management affordances (create, edit, delete, and the one-way pack-draft conversion) as governed by the `custom-presets` capability — so a user composes, manages, and picks experts in one place.

The Packs sub-tab SHALL host the pack marketplace surfaces (browse/search, my packs, creator drafts) migrated from the retired Settings packs section, preserving subscription, upgrade, uninstall, and report behavior as governed by `pack-marketplace` and `pack-installation`. Its internal tabs SHALL be **市场（Market）** and **我的（Mine）**; 「我的」SHALL contain two sections — 已安装（installed snapshots, updates, uninstall） and 我的创作（creator drafts and publish）— with the preset-conversion handoff landing on the 我的创作 section. The Packs sub-tab SHALL render only on deployments that report the pack marketplace (the platform predicate); on deployments without it the tab SHALL be absent and the page SHALL show Experts alone.

Sub-tab selection SHALL persist in the URL. On initial load with no query parameter, the first visible sub-tab SHALL be active (Experts under the factory preset). The retired Settings section routes SHALL redirect: `/settings/packs` to `/agents?tab=market` and `/settings/presets` to `/agents?tab=agents`, so existing deep links keep resolving.

#### Scenario: default to Agents sub-tab

- **WHEN** the user opens `/agents` with no `?tab` parameter under the factory preset
- **THEN** the Experts sub-tab SHALL be active and the unified expert roster SHALL be visible

#### Scenario: deep-link to Apps

- **WHEN** the user navigates to `/agents?tab=apps`
- **THEN** the page SHALL fall back to the first visible sub-tab (Experts); the Apps sub-tab is retired and no app entries SHALL render on this page

#### Scenario: deep-link to Market

- **WHEN** the user navigates to `/agents?tab=market` on a marketplace deployment
- **THEN** the Packs sub-tab SHALL be active and the marketplace surfaces SHALL be visible with 市场 / 我的 internal tabs

#### Scenario: 我的 contains installed and creations

- **WHEN** the user opens the Packs sub-tab's 「我的」 internal tab
- **THEN** installed packs with versions and update affordances render under 已安装, and the user's drafts with publish affordances render under 我的创作

#### Scenario: resolved layout hides a sub-tab

- **WHEN** the resolved layout for a user omits the Packs (market) sub-tab
- **THEN** the page renders without the Packs tab, a `?tab=market` deep link falls back to the first visible tab, and no error surfaces

#### Scenario: first visible tab active on narrowed presets

- **WHEN** the resolved layout hides the Experts tab (e.g. a marketplace-only preset) and the user opens `/agents` without a parameter
- **THEN** the first visible sub-tab SHALL be active

#### Scenario: Market tab is absent without a marketplace

- **WHEN** the deployment does not report the pack marketplace
- **THEN** the page SHALL render only the Experts sub-tab
- **AND** `/agents?tab=market` SHALL fall back to the Experts sub-tab

#### Scenario: retired Settings sections redirect into the page

- **WHEN** the user navigates to `/settings/packs` or `/settings/presets`
- **THEN** the page SHALL redirect to `/agents?tab=market` or `/agents?tab=agents` respectively, so existing deep links keep resolving
