# pack-agent-scoping Delta

## Purpose

Ties a pack persona to a focused resource set: selecting a pack role narrows the runtime to that pack's skills and MCP references plus a deployment baseline, so per-turn context cost and tool-choice quality follow the selected role. Selecting any non-pack mode restores today's full surface.

## ADDED Requirements

### Requirement: Resource scope is derived from the selected preset

The effective resource scope — which MCP servers and skills the runtime loads — SHALL be derived from the selected agent preset: a pack persona preset selects focused mode; the shipped presets and the built-in local agent select full mode (every installed server and skill, exactly today's behavior). The runtime SHALL re-derive the scope at every start, on every preset switch, and on every MCP or skill configuration change, so the composed runtime always matches the derivation; the scope SHALL NOT persist as independent state that can drift from the preset.

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

### Requirement: Focused mode loads the baseline plus the pack's resource set

In focused mode the runtime SHALL load only the deployment baseline together with the selected pack's resource set. The baseline SHALL be: every server in the operator's mcp.json layer, every server named in `PACK_BASELINE_MCP` that is installed and visible, and the deployment's bundled skills; operators own the baseline and pack manifests cannot extend it. A pack's resource set SHALL be its pack-owned skills (the rows the install recorded as owned by that pack) and its MCP references that are installed in the cell; a manifest entry skipped at install (name collision with foreign content) is NOT part of the set — the install report, not the manifest, is the record of what the pack owns here, the same principle the catalog's pack source applies. The user's personal availability settings intersect with the scope: focusing can only remove servers from what the user has enabled and SHALL NOT re-enable a server the user disabled. A pack whose manifest carries only agent entries focuses to the baseline alone.

#### Scenario: Focused tool surface is the pack's plus the baseline

- **WHEN** a subscriber selects a pack role whose pack owns two skills and references two registry servers
- **THEN** the focused runtime exposes exactly those four resources plus the baseline, and no other installed server or skill

#### Scenario: Collision-skipped skill stays out

- **WHEN** a pack's skill was skipped at install because a same-named user skill already existed
- **THEN** the focused view excludes that skill name entirely, and the user's own skill is visible only in full mode

#### Scenario: Personal disable wins over the manifest

- **WHEN** the user has disabled a server that the focused pack references
- **THEN** the focused runtime omits that server

#### Scenario: Persona-only pack focuses to the baseline

- **WHEN** a subscriber selects a role from a pack whose manifest has no skills and no MCP references
- **THEN** the focused runtime exposes exactly the baseline

#### Scenario: Unresolvable baseline entry is skipped

- **WHEN** `PACK_BASELINE_MCP` names a server that is not installed in the cell
- **THEN** the runtime starts without it and logs a warning instead of failing

### Requirement: Focus is visible to the user

The agent picker SHALL mark pack personas as focused roles, showing the pack identity (cross-referencing the `packId` the catalog serves for pack-sourced entries). The persona text generated for a pack role SHALL state that the role's tools and skills focus on its pack, so a request for capability outside the set gets an honest "not enabled for this role" answer that suggests switching modes, never invented results. Focus switching follows the existing preset-switch contract: rejected while a turn streams, applied to the next session, broadcast to all clients.

#### Scenario: Picker badges focused roles

- **WHEN** the catalog serves pack-sourced entries
- **THEN** the agent picker renders each with a focus mark naming its pack

#### Scenario: Role explains instead of hallucinating

- **WHEN** the user asks a focused role to use a tool outside its resource set
- **THEN** the role answers that the capability is not enabled for this role and points to switching back to a full mode

#### Scenario: Switch rejected mid-stream

- **WHEN** a mode switch is requested while a turn is streaming
- **THEN** the switch is rejected with an error, matching the existing `set_model` / `set_preset` guard

### Requirement: Focus is a property of the shared runtime

Focused/full mode SHALL be deployment-global state of the shared runtime, consistent with the existing deployment-global preset preference and the v1 shared-session ceiling: every connected client (web, mini-program) sees the same mode, and a switch by any client follows the serialized runtime-mutation path. Per-client scoping is out of scope for v1 and is documented rather than silently discovered.

#### Scenario: Second client sees the same mode

- **WHEN** a pack role is selected and another client connects
- **THEN** that client's runtime view and picker reflect the same focused mode as every other client

### Requirement: Scope savings are measured

The change SHALL ship a measurement probe that reports, for full and focused mode on a real deployment: the effective MCP server count with per-server tool counts, and a turn-tracing comparison of recorded token usage for the same prompt on the same model in both modes. Focused mode's tool roster on fd-prod is expected to land materially below the full roster (target band roughly 20–40 tools).

#### Scenario: Probe reports both modes

- **WHEN** the probe runs against a deployment with an installed pack
- **THEN** it reports the full versus focused server and tool counts, and the traced token delta for the reference prompt
