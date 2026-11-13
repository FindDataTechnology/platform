## MODIFIED Requirements

### Requirement: Agents & Apps page is a top-level route with sub-tabs
The `/agents` route SHALL be a top-level page (replacing the legacy location; no parent shell). The page SHALL render three sub-tabs — **Experts（专家）**, **Market（行业方案）**, **Apps（应用）** — with a stable `?tab=` query parameter for deep-linking whose values SHALL be `agents` (Experts), `market` (Market), and `apps` (Apps); the legacy `agents` and `apps` values SHALL keep resolving to their tabs.

The Experts sub-tab SHALL present the unified expert roster: `agent-local` and `agent-remote` entries from all catalog sources (built-in, cloud, registry, installed packs) alongside the cell's custom presets, with custom-preset entries offering inline management affordances (create, edit, delete, and the one-way pack-draft conversion) as governed by the `custom-presets` capability — so a user composes, manages, and picks experts in one place.

The Market sub-tab SHALL host the pack marketplace surfaces (browse/search, subscribed/我的, creator drafts) migrated from the retired Settings packs section, preserving subscription, upgrade, uninstall, and report behavior as governed by `pack-marketplace` and `pack-installation`. The Market sub-tab SHALL render only on deployments that report the pack marketplace (the same gating the retired Settings section applied); on deployments without it the tab SHALL be absent and the page SHALL fall back to Experts and Apps.

The Apps sub-tab SHALL list `app` entries (link, nango-connect, external-service), unchanged. Sub-tab selection SHALL persist in the URL. On initial load with no query parameter, the Experts sub-tab SHALL be active. The retired Settings section routes SHALL redirect: `/settings/packs` to `/agents?tab=market` and `/settings/presets` to `/agents?tab=agents`, so existing deep links keep resolving.

#### Scenario: default to Agents sub-tab
- **WHEN** the user navigates to `/agents` with no query parameter
- **THEN** the Experts sub-tab SHALL be active and the unified expert roster SHALL be visible

#### Scenario: deep-link to Apps
- **WHEN** the user navigates to `/agents?tab=apps`
- **THEN** the Apps sub-tab SHALL be active and only app entries SHALL be visible
- **AND** the URL SHALL retain the query parameter after switching tabs

#### Scenario: deep-link to Market
- **WHEN** the user navigates to `/agents?tab=market` on a deployment with the pack marketplace
- **THEN** the Market sub-tab SHALL be active and the marketplace browse surface SHALL be visible

#### Scenario: Market tab is absent without a marketplace
- **WHEN** the deployment does not report the pack marketplace
- **THEN** the page SHALL render only the Experts and Apps sub-tabs
- **AND** `/agents?tab=market` SHALL fall back to the Experts sub-tab

#### Scenario: retired Settings sections redirect into the page
- **WHEN** the user navigates to `/settings/packs` or `/settings/presets`
- **THEN** the router SHALL redirect to `/agents?tab=market` or `/agents?tab=agents` respectively
- **AND** no Settings section SHALL render for packs or presets

### Requirement: Catalog schema is unchanged by the agents page relocation
The agents page restructure (Experts / Market / Apps sub-tabs and the migration of the preset and pack management surfaces into the page) SHALL only change rendering surfaces; the entry schema, fetching, merge, role filter, and Nango broker SHALL be preserved unchanged.

#### Scenario: catalog behavior is preserved
- **WHEN** the catalog is served
- **THEN** all three entry types SHALL be returned in `GET /api/catalog` exactly as before
