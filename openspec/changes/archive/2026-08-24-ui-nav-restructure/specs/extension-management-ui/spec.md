# extension-management-ui delta

## ADDED Requirements

### Requirement: MCP Servers and Skills are top-level routes
The web UI SHALL mount the MCP Servers management page at `/mcp` and the Skills management page at `/skills` (replacing the legacy `/extensions/mcp` and `/extensions/skills` sub-routes). The legacy `/extensions` parent page and its two-card selector SHALL be removed; visiting `/extensions` SHALL redirect to `/mcp`. Visiting the legacy `/extensions/mcp` or `/extensions/skills` paths SHALL redirect to the new top-level routes (`/mcp` and `/skills` respectively) so existing deep-links and bookmarks continue to work.

#### Scenario: visit legacy extensions path
- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/mcp`
- **WHEN** the user navigates to `/extensions/mcp`
- **THEN** the router SHALL redirect to `/mcp`
- **WHEN** the user navigates to `/extensions/skills`
- **THEN** the router SHALL redirect to `/skills`

#### Scenario: new top-level routes work directly
- **WHEN** the user clicks the "MCP Servers" sidebar tab
- **THEN** the URL SHALL be `/mcp` and the MCP management page SHALL render
- **AND** the Installed / Market sub-tabs SHALL behave as before (this change does not touch the MCP management page itself)

### Requirement: Installed / Market tabs preserved
The MCP and Skills management pages SHALL keep their existing Installed / Market sub-tabs and the existing add/edit/remove/toggle behavior. This change only moves the route; the management UX is unchanged.

#### Scenario: sub-tabs still work at new route
- **WHEN** the user visits `/mcp`
- **THEN** the MCP management page SHALL render with the Installed / Market sub-tabs
- **AND** selecting Market SHALL show the MCP market view exactly as before this change
