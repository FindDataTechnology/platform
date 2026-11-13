## MODIFIED Requirements

### Requirement: Resource scope is derived from the selected preset

The effective resource scope — which MCP servers and skills the runtime loads — SHALL be derived from the selected agent preset together with the overlay recorded for that preset: a pack persona preset selects focused mode; the shipped presets and the built-in local agent select full mode (every installed server and skill, exactly today's behavior). The runtime SHALL re-derive the scope at every start, on every preset switch, and on every MCP or skill configuration change, so the composed runtime always matches the derivation; the scope SHALL NOT persist as independent state that can drift — the overlay stores only per-role add/remove preferences, never a materialized resource set (spec: focus-overlay).

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

### Requirement: Focused mode loads the baseline plus the pack's resource set

In focused mode the runtime SHALL load only the deployment baseline together with the selected persona's resource set — the subset of the pack's resources that the persona's declaration names, defaulting to the whole pack's set when the persona declares none — with the preset's overlay applied after the derivation: additions drawn from the enabled universe, removals of any member of the derived set (spec: focus-overlay). The baseline SHALL be: every server in the operator's mcp.json layer, every server named in `PACK_BASELINE_MCP` that is installed and visible, and the deployment's bundled skills; operators own the baseline and pack manifests cannot extend it (an overlay removal narrows the user's own runtime; it does not edit the baseline definition). A pack's resources SHALL be its pack-owned skills (the rows the install recorded as owned by that pack) and its MCP references that are installed in the cell; a manifest entry skipped at install (name collision with foreign content) is NOT part of any persona's set — the install report, not the manifest, is the record of what the pack owns here. A persona's declaration SHALL name only skills and MCP references within the pack's own lists, and each dimension (skills, MCP) SHALL scope independently: an absent dimension keeps the whole-pack set for that dimension, while a present-but-empty dimension yields none. The user's personal availability settings intersect with the scope: focusing can only remove servers from what the user has enabled, an overlay addition SHALL NOT re-enable a server the user disabled, and a persona whose effective set is empty focuses to the baseline alone.

#### Scenario: Focused tool surface is the pack's plus the baseline

- **WHEN** a subscriber selects a pack role whose pack owns two skills and references two registry servers
- **THEN** the focused runtime exposes exactly those four resources plus the baseline, and no other installed server or skill

#### Scenario: Declared subset narrows the focused surface

- **WHEN** a subscriber selects a pack role whose pack owns three skills and references three servers, and the role's declaration names two skills and one server
- **THEN** the focused runtime exposes exactly those two skills and that one server plus the baseline, and no other installed server or skill

#### Scenario: Undeclared persona keeps the whole pack set

- **WHEN** a subscriber selects a role from a pack whose agents carry no resource declarations
- **THEN** the focused runtime exposes the pack's every owned skill and installed MCP reference plus the baseline — exactly the pre-change behavior, with no re-subscription or migration

#### Scenario: Dimensions scope independently

- **WHEN** a persona declaration names skills but not MCP references
- **THEN** the focused skills are the declared subset while the focused MCP surface stays the pack's whole referenced set (intersected with installed and enabled), and symmetrically for the converse

#### Scenario: Present-but-empty declaration focuses to the baseline

- **WHEN** a persona declaration lists no skills and no MCP references
- **THEN** the focused runtime exposes exactly the baseline

#### Scenario: Persona-only pack focuses to the baseline

- **WHEN** a subscriber selects a role from a pack whose manifest has no skills and no MCP references
- **THEN** the focused runtime exposes exactly the baseline

#### Scenario: Collision-skipped skill stays out

- **WHEN** a pack's skill was skipped at install because a same-named user skill already existed
- **THEN** the focused view excludes that skill name for every persona of the pack, and the user's own skill is visible only in full mode

#### Scenario: Personal disable wins over the manifest

- **WHEN** the user has disabled a server that the focused persona's declaration names
- **THEN** the focused runtime omits that server

#### Scenario: Unresolvable baseline entry is skipped

- **WHEN** `PACK_BASELINE_MCP` names a server that is not installed in the cell
- **THEN** the runtime starts without it and logs a warning instead of failing

#### Scenario: Upgrade with changed declarations re-derives

- **WHEN** a focused pack is upgraded to a version whose persona declaration adds or drops skills or MCP references
- **THEN** the focused runtime reflects the new declaration on its next composition

#### Scenario: Overlay addition extends the focused surface

- **WHEN** a role's overlay adds an enabled server and an available skill
- **THEN** the focused runtime exposes the derived set plus those two additions and the baseline

#### Scenario: Overlay removal may drop a baseline member

- **WHEN** a role's overlay removes a baseline server
- **THEN** that role's focused runtime omits it while every other role and full mode still load it

### Requirement: Focus is a property of the shared runtime

Focused/full mode and each role's overlay SHALL be deployment-global state of the shared runtime, consistent with the existing deployment-global preset preference and the v1 shared-session ceiling: every connected client (web, mini-program) sees the same mode and the same adjustments, and a switch or adjustment by any client follows the serialized runtime-mutation path. Per-client scoping is out of scope for v1 and is documented rather than silently discovered.

#### Scenario: Second client sees the same mode

- **WHEN** a pack role is selected and another client connects
- **THEN** that client's runtime view and picker reflect the same focused mode as every other client

#### Scenario: Second client sees the same adjustments

- **WHEN** one client adjusts a role's overlay and another client inspects the same role
- **THEN** the other client's adjustment view shows the same effective set and preferences
