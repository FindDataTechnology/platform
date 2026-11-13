# agent-catalog delta

## ADDED Requirements

### Requirement: Agents & Apps page is a top-level route with sub-tabs
The `/agents` route SHALL be a top-level page (replacing the legacy location; no parent shell). The page SHALL render two sub-tabs: **Agents** and **Apps**, with a stable `?tab=apps|agents` query parameter for deep-linking. The Agents sub-tab SHALL list `agent-local` and `agent-remote` entries. The Apps sub-tab SHALL list `app` entries (link, nango-connect, external-service). Sub-tab selection SHALL persist in the URL. On initial load with no query parameter, the Agents sub-tab SHALL be active.

#### Scenario: default to Agents sub-tab
- **WHEN** the user navigates to `/agents` with no query parameter
- **THEN** the Agents sub-tab SHALL be active and the Agents section SHALL be visible

#### Scenario: deep-link to Apps
- **WHEN** the user navigates to `/agents?tab=apps`
- **THEN** the Apps sub-tab SHALL be active and only app entries SHALL be visible
- **AND** the URL SHALL retain the query parameter after switching tabs

### Requirement: Catalog entry types remain unchanged
The catalog SHALL continue to accept entries of three types: `agent-local`, `agent-remote`, and `app` (with its `kind` variants). This change only relocates the rendering surface to a tabbed layout under `/agents`; the entry schema, fetching, merge, role filter, and Nango broker are preserved unchanged.

#### Scenario: catalog behavior is preserved
- **WHEN** the catalog is served
- **THEN** all three entry types SHALL be returned in `GET /api/catalog` exactly as before
- **AND** the Agents sub-tab SHALL show `agent-local` and `agent-remote` entries
- **AND** the Apps sub-tab SHALL show `app` entries
