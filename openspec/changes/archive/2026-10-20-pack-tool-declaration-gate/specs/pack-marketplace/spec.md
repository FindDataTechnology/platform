## ADDED Requirements

### Requirement: The detail view discloses each MCP reference's tool face

The pack detail view SHALL render, for every MCP reference of the published version, the tool face the pack actually mounts: for an allowlisted reference, the declared tool count against the server's catalog-served total (for example "6 / 161 工具"); for a `fullSurface` reference, the server's full tool count together with the author's stated reason. A version published before the explicit-declaration gate — carrying neither — SHALL render as the full surface, marked as undeclared.

The disclosure SHALL be derived from the immutable version manifest plus the catalog's `tool_list`; it SHALL NOT require a live call to the server.

#### Scenario: Allowlisted reference shows declared versus total

- **WHEN** a user opens the detail view of a pack whose `fd-daas-mcp` reference declares 5 tools
- **THEN** the view shows 5 against the catalog's total for that server, and no reason line

#### Scenario: Full-surface reference shows its reason

- **WHEN** a pack marks `law-bench` full-surface with a reason
- **THEN** the detail view shows the server's full tool count and the reason text

#### Scenario: Legacy version renders as undeclared full surface

- **WHEN** a published version predates the gate and its reference carries no declaration
- **THEN** the view shows the full tool count marked as undeclared, and the page still renders normally
