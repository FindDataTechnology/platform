## ADDED Requirements

### Requirement: MCP Servers and Skills are Settings sections

The web UI SHALL mount the MCP Servers management page as the Settings modal's `mcp` section at `/settings/mcp`, and the Skills management page as the Settings modal's `skills` section at `/settings/skills`. Neither SHALL be a sidebar navigation tab.

The legacy paths `/mcp`, `/skills`, `/extensions`, `/extensions/mcp`, and `/extensions/skills` SHALL each redirect to the corresponding new Settings route, so existing deep links and bookmarks continue to resolve rather than 404. The redirect SHALL be a redirect and not an alias: exactly one canonical URL SHALL render each section.

This requirement changes the container only. The MCP and Skills page components, their controls, their form and dialog behavior, and their `data-testid` attributes SHALL be unchanged — they are reused verbatim as Settings section panes. No page body is rewritten by this change.

#### Scenario: legacy extension paths redirect into Settings

- **WHEN** the user navigates to `/mcp`
- **THEN** the router SHALL redirect to `/settings/mcp`
- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/settings/mcp`
- **WHEN** the user navigates to `/extensions/mcp`
- **THEN** the router SHALL redirect to `/settings/mcp`
- **WHEN** the user navigates to `/skills`
- **THEN** the router SHALL redirect to `/settings/skills`
- **WHEN** the user navigates to `/extensions/skills`
- **THEN** the router SHALL redirect to `/settings/skills`

#### Scenario: Settings sections render the management panes

- **WHEN** the user opens the Settings modal and selects the MCP section
- **THEN** the URL SHALL be `/settings/mcp`
- **AND** the MCP Servers management pane SHALL render inside the modal
- **WHEN** the user selects the Skills section
- **THEN** the URL SHALL be `/settings/skills`
- **AND** the Skills management pane SHALL render inside the modal

#### Scenario: page internals and test identifiers are unchanged

- **WHEN** the MCP or Skills pane renders inside the Settings modal
- **THEN** every control, form, dialog, and empty state SHALL behave exactly as it did on the former standalone page
- **AND** every `data-testid` attribute within the pane SHALL retain the value it had before this change

#### Scenario: the page-level heading is dropped as a duplicate

- **WHEN** the MCP or Skills pane renders inside the Settings modal
- **THEN** it SHALL NOT render a page-level `<h1>` naming the pane
- **AND** the modal's section navigation SHALL be the sole label for it
- **AND** the section heading within the pane body SHALL remain

The former page header is the one exception to "container only". It rendered an `<h1>` that repeated the label now shown in the modal's nav, and beneath it a subtitle bound to `extensions.mcp.description` / `extensions.skills.description` — keys that were never defined in any locale, so the raw key string rendered to the user. The parity guard did not catch it because the keys were absent from all five bundles equally. Deleting the header resolves both.

#### Scenario: MCP and Skills are absent from the sidebar navigation

- **WHEN** the sidebar renders
- **THEN** no "MCP Servers" navigation tab SHALL be present
- **AND** no "Skills" navigation tab SHALL be present
- **AND** both SHALL be reachable only through the Settings modal or their canonical `/settings/*` URLs

## MODIFIED Requirements

### Requirement: Installed / Market tabs preserved

The MCP and Skills management panes SHALL keep their existing Installed / Market sub-tabs and the existing add/edit/remove/toggle behavior. This change only moves the route and the container; the management UX is unchanged.

#### Scenario: sub-tabs still work at new route

- **WHEN** the user visits `/settings/mcp`
- **THEN** the MCP management pane SHALL render with the Installed / Market sub-tabs
- **AND** selecting Market SHALL show the MCP market view exactly as before this change

## REMOVED Requirements

### Requirement: Extensions page is accessible from navigation

**Reason**: There is no longer an "Extensions" page or navigation entry. The combined page and its two-tab selector were already superseded by separate MCP and Skills routes; this change completes the move by turning both into Settings modal sections, and the sidebar navigation is reduced to work surfaces only (Chat, Knowledge, Agents, Bots, Trace).

**Migration**: Use the Settings modal. MCP server management is at `/settings/mcp` and skill management is at `/settings/skills`; both are reachable from the sidebar gear or `Cmd/Ctrl + ,`. The legacy `/settings/extensions`, `/extensions`, `/extensions/mcp`, and `/extensions/skills` paths redirect to the new Settings routes. See the new requirement "MCP Servers and Skills are Settings sections".

### Requirement: MCP Servers and Skills are top-level routes

**Reason**: MCP Servers and Skills are configuration surfaces, not work surfaces, so they no longer warrant top-level routes or sidebar tabs. Under the new placement rule — nav holds work surfaces, Settings holds configuration — both become sections of the Settings modal, which lets the user change a setting and return to their chat without leaving the page.

**Migration**: The top-level routes `/mcp` and `/skills` now redirect to `/settings/mcp` and `/settings/skills` respectively, as do the older `/extensions`, `/extensions/mcp`, and `/extensions/skills` paths. Deep links and bookmarks continue to work. The management pages themselves are unchanged. See the new requirement "MCP Servers and Skills are Settings sections".
