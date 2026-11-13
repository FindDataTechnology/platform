# pack-agent-scoping Delta (add-mcp-tool-scoping)

## ADDED Requirements

### Requirement: Focused mode narrows tools within a kept server

When a focused role's effective resource set includes an MCP reference that carries a tool allowlist — the pack-level allowlist narrowed by the role's own `mcpTools` declaration when present — the role's session SHALL expose only the allowlisted tools of that server: tools outside the allowlist SHALL NOT appear in the role's visible tool roster, and a call to such a tool SHALL be denied with a readable reason naming the tool and the role's focused scope, never a silent failure. Baseline servers and references without allowlists SHALL keep their full tool surface exactly as before this change. Interception SHALL be hard — no runtime condition (server drift, tool-set change, restart) may leave an out-of-allowlist tool callable by the role — while roster narrowing SHALL be best-effort: a drifted tool set may briefly widen what the roster lists, but a call to any out-of-allowlist tool is still denied. The effective tool set SHALL be re-derived at every composition from the installed version snapshot, following the same derivation rules as the server and skill dimensions.

#### Scenario: Allowlisted tools only in the roster

- **WHEN** a subscriber selects a role whose pack reference to a server declares a three-tool allowlist
- **THEN** the role's session roster lists exactly those three tools of that server and none of its other tools

#### Scenario: Undeclared tool call is denied with a readable reason

- **WHEN** the role's model attempts to call a tool of that server outside the allowlist
- **THEN** the call is denied with a reason naming the tool and stating it is outside the role's focused scope, and the conversation continues

#### Scenario: Role-level narrowing applies below the pack level

- **WHEN** a pack reference declares a five-tool allowlist and the selected role's declaration narrows it to two
- **THEN** the role's roster lists exactly those two tools of that server

#### Scenario: No allowlist keeps the full surface

- **WHEN** a focused role's effective set includes a reference without any allowlist, and a baseline server
- **THEN** both expose their full tool surfaces exactly as before this change

#### Scenario: Server drift never widens callability

- **WHEN** the server adds tools after the pack version was published, or removes an allowlisted tool
- **THEN** the new tools remain uncallable by the role, and a call to the removed allowlisted tool fails with a readable error instead of a silent or hung call

#### Scenario: Full mode is unaffected

- **WHEN** the user switches from the role to a shipped mode or the built-in agent
- **THEN** every installed server exposes its full tool surface exactly as before this change
