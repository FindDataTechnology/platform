## ADDED Requirements

### Requirement: Custom presets may narrow MCP tools per server

A custom preset's resource declaration MAY carry an `mcpTools` dimension: a mapping from the preset's own MCP references to tool leaf names. When declared for a referenced server, the preset's focused sessions SHALL expose only those tools of that server. The mapping SHALL only narrow — a preset cannot add a tool beyond what the server's catalog-served surface lists, and names SHALL be chosen from that surface (no free-form entry). When a preset declares no `mcpTools` for a referenced server, the preset SHALL inherit the full-mode derived scope for that server (the union of installed packs' allowlists when a pack references it, otherwise the complete surface) rather than silently widening to the whole surface.

A server the user has marked full-surface SHALL keep its complete surface for the preset as well; the marker outranks the preset's narrowing.

#### Scenario: Declared tools narrow the focused roster

- **WHEN** a custom preset references `fd-open-data-mcp` and declares two of its tools
- **THEN** the preset's focused sessions expose exactly those two tools of that server

#### Scenario: Absent declaration inherits the derived scope

- **WHEN** a custom preset references `fd-quant`, an installed pack references it with a 6-tool allowlist, and the preset declares no `mcpTools`
- **THEN** the preset's focused sessions expose those 6 tools, not the server's full 50

#### Scenario: Unknown tool name is rejected at edit time

- **WHEN** a user enters a tool name that the catalog's tool list for the referenced server does not contain
- **THEN** the editor rejects the entry and the preset is not saved with that name

#### Scenario: Full-surface marker outranks the preset

- **WHEN** the user marks a server full-surface and a custom preset declares two of its tools
- **THEN** the preset's sessions expose the complete surface of that server
