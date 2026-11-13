## MODIFIED Requirements

### Requirement: Resource scope is derived from the selected preset

The effective resource scope — which MCP servers, skills, and MCP tools the runtime loads — SHALL be derived from the selected agent preset together with the overlay recorded for that preset, over three preset families: a pack persona preset selects focused mode on its persona's resource set; a custom preset (openspec: custom-presets) selects focused mode on its declared resources intersected with what is locally available; and the shipped presets and the built-in local agent select full mode — every installed server and skill, with the tool dimension derived as the union of the installed packs' declared allowlists for each server those packs reference, and the full surface for every server no installed pack references or the user has marked full-surface (spec: full-mode tool scope). The runtime SHALL re-derive the scope at every start, on every preset switch, and on every MCP or skill configuration change, so the composed runtime always matches the derivation; the scope SHALL NOT persist as independent state that can drift — the overlay stores only per-role add/remove preferences, and the per-server full-surface marker is a separate global preference (`toolScope.fullSurface`); neither is ever a materialized resource set (spec: focus-overlay).

#### Scenario: Boot under a focused selection

- **WHEN** the runtime starts while a pack persona is the selected preset
- **THEN** the runtime composes focused (baseline plus that pack's resources) with no user action — a stale full-surface patch left behind by a crash cannot survive a restart

#### Scenario: Switching back restores the full surface

- **WHEN** the user switches from a pack role to a shipped mode or the built-in agent
- **THEN** the next session composes with every installed server and skill; each server referenced by an installed pack carries that pack set's declared tool union unless the user marked it full-surface, and every other server keeps its complete tool surface

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

## ADDED Requirements

### Requirement: Full mode narrows pack-referenced servers to their declared union

In full mode, for each MCP server referenced by one or more installed packs, the runtime SHALL expose only the union of those packs' effective tool allowlists for that server. A server referenced by no installed pack SHALL keep its complete tool surface, exactly as before this change. A server referenced by any pack that declares `fullSurface` — or by any pack reference that carries no tool declaration at all — SHALL keep its complete tool surface: an absent declaration contributes the full surface to the union, never an empty set.

The union SHALL be recomputed at every composition from the installed pack manifests — never persisted as a materialized allowlist — so installing, upgrading, or uninstalling a pack re-derives the full-mode surface without further action. When no pack is installed, full mode SHALL compose with no filter at all, byte-identical to the pre-change behavior.

#### Scenario: Union of two packs narrows a shared server

- **WHEN** two installed packs both reference `fd-quant`, declaring 6 and 9 tools respectively
- **THEN** full mode exposes exactly the union of those tool sets for `fd-quant`, and nothing outside it

#### Scenario: Unreferenced servers keep their full surface

- **WHEN** the user installed an MCP server directly and no installed pack references it
- **THEN** full mode exposes that server's complete tool surface

#### Scenario: An undeclared reference contributes the full surface

- **WHEN** an installed pack references `fd-quant` with no tool declaration while another declares 6 tools
- **THEN** full mode exposes all 50 tools of `fd-quant`, not the 6-tool union — an absent declaration never narrows

#### Scenario: Uninstalling the last referencing pack lifts the filter

- **WHEN** the last installed pack referencing `fd-quant` is uninstalled
- **THEN** the next composition exposes `fd-quant`'s complete tool surface

#### Scenario: No packs installed composes unfiltered

- **WHEN** the cell has no installed packs
- **THEN** full mode writes no tool filter and the composed runtime matches the pre-change behavior

### Requirement: Per-server full-surface override

The user SHALL be able to mark any MCP server as full-surface from the MCP settings surface. A marked server SHALL expose its complete tool surface in every mode, outranking both the full-mode union and any pack-level allowlist for that server. The marker SHALL persist across restarts and recompositions, and SHALL be reversible.

A tool call denied by a pack allowlist SHALL name the server, the tool, and this setting as the escape hatch (the bridge's denial copy points at Settings → MCP); the bridge's guard/restrict execution logic otherwise stays unchanged.

#### Scenario: Override restores the complete surface

- **WHEN** the user marks `fd-daas-mcp` full-surface while an installed pack declares 5 of its 161 tools
- **THEN** the next composition exposes all 161 tools of `fd-daas-mcp`, in full mode and in focused modes alike

#### Scenario: Override survives a pack upgrade

- **WHEN** a pack referencing the overridden server is upgraded and the runtime recomposes
- **THEN** the server remains full-surface

#### Scenario: Removing the override re-applies the derived scope

- **WHEN** the user removes the full-surface marker
- **THEN** the next composition re-applies the derived allowlist (the pack union in full mode, the pack's own list in focused mode)
