## MODIFIED Requirements

### Requirement: Focused mode loads the baseline plus the pack's resource set

In focused mode the runtime SHALL load only the deployment baseline together with the selected persona's resource set — the subset of the pack's resources that the persona's declaration names, defaulting to the whole pack's set when the persona declares none. The baseline SHALL be: every server in the operator's mcp.json layer, every server named in `PACK_BASELINE_MCP` that is installed and visible, and the deployment's bundled skills; operators own the baseline and pack manifests cannot extend it. A pack's resources SHALL be its pack-owned skills (the rows the install recorded as owned by that pack) and its MCP references that are installed in the cell; a manifest entry skipped at install (name collision with foreign content) is NOT part of any persona's set — the install report, not the manifest, is the record of what the pack owns here, the same principle the catalog's pack source applies. A persona's declaration SHALL name only skills and MCP references within the pack's own lists, and each dimension (skills, MCP) SHALL scope independently: an absent dimension keeps the whole-pack set for that dimension, while a present-but-empty dimension yields none. The user's personal availability settings intersect with the scope: focusing can only remove servers from what the user has enabled and SHALL NOT re-enable a server the user disabled. A persona whose effective set is empty — a persona-only pack, or an empty declaration — focuses to the baseline alone.

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

### Requirement: Focus is visible to the user

The agent picker SHALL mark pack personas as focused roles, showing the pack identity (cross-referencing the `packId` the catalog serves for pack-sourced entries) together with the role's resource summary — the skill and MCP server counts of that persona's effective set, whether declared or defaulted. The persona text generated for a pack role SHALL state that the role's tools and skills focus on its own resource set, so a request for capability outside the set gets an honest "not enabled for this role" answer that suggests switching modes, never invented results. Focus switching follows the existing preset-switch contract: rejected while a turn streams, applied to the next session, broadcast to all clients.

#### Scenario: Picker badges focused roles

- **WHEN** the catalog serves pack-sourced entries
- **THEN** the agent picker renders each with a focus mark naming its pack and that role's skill and server counts

#### Scenario: Role explains instead of hallucinating

- **WHEN** the user asks a focused role to use a tool outside its resource set
- **THEN** the role answers that the capability is not enabled for this role and points to switching back to a full mode

#### Scenario: Switch rejected mid-stream

- **WHEN** a mode switch is requested while a turn is streaming
- **THEN** the switch is rejected with an error, matching the existing `set_model` / `set_preset` guard

### Requirement: Scope savings are measured

The change SHALL ship a measurement probe that reports, for full mode and for each persona of the installed packs on a real deployment: the effective MCP server count with per-server tool counts, and a turn-tracing comparison of recorded token usage for the same prompt on the same model in full mode versus that persona's focused mode. Each persona's tool roster on fd-prod is expected to land materially below the full roster (target band roughly 20–40 tools).

#### Scenario: Probe reports both modes

- **WHEN** the probe runs against a deployment with an installed pack
- **THEN** it reports the full versus focused server and tool counts, and the traced token delta for the reference prompt

#### Scenario: Probe reports per persona

- **WHEN** the probe runs against a deployment with an installed multi-agent pack
- **THEN** it reports the full roster once and, per persona, the focused server and tool counts and the traced token delta for the reference prompt
