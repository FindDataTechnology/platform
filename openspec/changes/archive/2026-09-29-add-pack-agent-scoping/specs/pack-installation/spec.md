# pack-installation Delta

## MODIFIED Requirements

### Requirement: Pack agents run as local personas

A subscribed pack's agent entries SHALL appear in the subscriber's agent picker and, when selected, SHALL run as a local persona in the subscriber's runtime — the platform's currently selected model with the pack persona's behavior — composed with the pack's resource set and the deployment baseline (openspec: pack-agent-scoping): the pack's own skills and MCP references plus the deployment's always-on baseline, not the subscriber's entire installed surface. Switching back to a shipped mode or the built-in agent restores the full surface.

#### Scenario: Pack agent selectable and local

- **WHEN** a subscriber selects a pack's agent and sends a message
- **THEN** the persona runs in the local runtime and can invoke the pack's skills and MCP tools plus the deployment baseline in the same conversation

#### Scenario: Focus follows the existing switch contract

- **WHEN** a subscriber selects or deselects a pack's agent
- **THEN** the focus change applies through the same preset-switch path as before this change (rejected while streaming, applied to the next session, broadcast to clients)
