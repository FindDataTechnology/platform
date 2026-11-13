## MODIFIED Requirements

### Requirement: Resource scope is derived from the selected preset

The effective resource scope — which MCP servers and skills the runtime loads — SHALL be derived from the selected agent preset together with the overlay recorded for that preset, over three preset families: a pack persona preset selects focused mode on its persona's resource set; a custom preset (openspec: custom-presets) selects focused mode on its declared resources intersected with what is locally available; and the shipped presets and the built-in local agent select full mode (every installed server and skill, exactly today's behavior). The runtime SHALL re-derive the scope at every start, on every preset switch, and on every MCP or skill configuration change, so the composed runtime always matches the derivation; the scope SHALL NOT persist as independent state that can drift — the overlay stores only per-role add/remove preferences, never a materialized resource set (spec: focus-overlay).

#### Scenario: Boot under a focused selection

- **WHEN** the runtime starts while a pack persona is the selected preset
- **THEN** the runtime composes focused (baseline plus that pack's resources) with no user action — a stale full-surface patch left behind by a crash cannot survive a restart

#### Scenario: Switching back restores the full surface

- **WHEN** the user switches from a pack role to a shipped mode or the built-in agent
- **THEN** the next session composes with every installed server and skill, exactly as before this change

#### Scenario: Configuration changes while focused keep the focus

- **WHEN** an MCP server or skill is added, removed, or toggled while a pack role is selected
- **THEN** the resulting runtime still composes focused, applying the change within the focused set

#### Scenario: Pack upgrade re-derives the set

- **WHEN** a focused pack is upgraded to a version that adds or drops MCP references or skills
- **THEN** the focused runtime reflects the new version's resource set on its next composition

#### Scenario: Existing installed packs need no re-subscription

- **WHEN** the deployment upgrades to this change with packs already installed
- **THEN** those packs' skills remain invocable in full mode and focusable in focused mode with no user action (materialization is rebuilt from the durable store)

#### Scenario: Overlay adjustment recomposes the scope

- **WHEN** a role's overlay is adjusted
- **THEN** the next composition of that role's runtime reflects the preset's derivation plus the adjusted preferences

#### Scenario: A custom preset focuses on its declared resources

- **WHEN** the selected preset is a custom preset referencing two skills and one server, one of which is not available in the cell
- **THEN** the runtime composes focused on the baseline plus the two available resources, and recomposes without user action when the unavailable reference becomes available again
