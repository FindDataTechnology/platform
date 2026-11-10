# custom-presets Specification

## Purpose

User-composed persona presets: any authenticated user assembles a conversational role from locally-available resources on their own cell — focused by construction, cell-local by design.

## Requirements

### Requirement: Custom presets are created and managed in the cell

Authenticated users SHALL be able to create, edit, and delete custom presets, each carrying a display name, persona text, and optional tags and icon — persona-only, with no endpoint, model, or credential fields in the editor or the stored row. Preset ids SHALL be server-assigned under the reserved `user.` prefix; authors choose display names, never ids. The roster SHALL be deployment-global state of the shared runtime: every connected client sees the same presets, and any authenticated user may manage them. Management mutations SHALL follow the serialized runtime-mutation path (catalog refresh, idle-runtime restart) and SHALL be rejected while a turn is streaming. A preset MAY additionally carry sample prompts (`examples`, at most 3 strings of at most 200 characters each); absent examples change nothing for any existing consumer.

#### Scenario: Created preset appears in the picker

- **WHEN** a user creates a custom preset with a display name, persona text, and two skill references
- **THEN** the preset appears in the agent picker (badged as a focused role) after the serialized refresh, without a manual reload

#### Scenario: Edit applies like a persona regeneration

- **WHEN** a user edits a custom preset's persona text or resource references while the runtime is idle
- **THEN** the generated preset and the focused composition regenerate on the next session, the same path a catalog change rides

#### Scenario: Delete prunes and resets a stale selection

- **WHEN** a user deletes the currently selected custom preset
- **THEN** its generated preset is pruned, the selection falls back to the built-in agent, and clients are told through `agent_changed` — the same self-healing an unsubscribed pack's agent gets

#### Scenario: Ids are server-assigned under the reserved prefix

- **WHEN** a user creates a custom preset
- **THEN** its id is assigned by the cell under the `user.` prefix, and no field lets the author type an arbitrary id

#### Scenario: Sample prompts ride the preset and flow to the pack draft

- **WHEN** a preset carrying 1-3 sample prompts is converted into a pack draft
- **THEN** the draft's agent entry carries them as `serving.card.examples`, and a preset with no examples produces no card key

#### Scenario: Over-bound sample prompts are rejected

- **WHEN** a create or edit body carries more than 3 examples or any example over 200 characters
- **THEN** the mutation is rejected with a named error and the stored row is untouched

### Requirement: Resource references resolve at composition

A custom preset's resource references SHALL draw from the locally-available universe: skills present in the cell (the user's own or any installed pack's) and servers installed in the cell. Composition SHALL intersect the references with what is actually available: an unavailable entry is omitted silently and regains effect if it becomes available again, and a reference SHALL NOT re-enable a server the user has disabled.

#### Scenario: Cross-pack skill follows its pack's lifecycle

- **WHEN** a custom preset references another installed pack's skill
- **THEN** the role exposes that skill while the pack is installed, stops exposing it when the pack is uninstalled, and exposes it again after a reinstall

#### Scenario: Disabled server reference stays omitted

- **WHEN** a custom preset references a server the user has disabled
- **THEN** the focused runtime omits that server

#### Scenario: Empty references focus to the baseline

- **WHEN** a custom preset declares no skills and no servers
- **THEN** selecting it composes exactly the deployment baseline

### Requirement: Custom presets are focused by construction

Selecting a custom preset SHALL compose focused mode: the deployment baseline plus the preset's declared resources (openspec: pack-agent-scoping's derivation takes a third preset family), with the preset's overlay applied after (spec: focus-overlay). The picker SHALL badge a custom preset as a focused role with its resource summary, and its generated persona SHALL carry the focus note so requests outside the set get an honest answer.

#### Scenario: Selecting composes focused

- **WHEN** a user selects a custom preset referencing two skills and one server
- **THEN** the next session composes with exactly those resources plus the baseline, and switching back to a shipped mode or the built-in agent restores the full surface

#### Scenario: The overlay applies to custom presets

- **WHEN** a custom preset has a stored overlay adding a server
- **THEN** its focused composition includes the addition, under the same add/remove rules as pack roles

### Requirement: Custom presets stay cell-local

A custom preset SHALL NOT be publishable to the marketplace and SHALL NOT appear in any marketplace surface; it exists only in its cell's roster. Sharing a composition SHALL go through authoring a pack draft in the marketplace's creator path, never through a local preset gaining a publish action. The preset management surface SHALL offer exactly one export-shaped affordance: a one-way conversion action that pre-fills a new pack draft in the author's own cell (openspec: pack-authoring); the conversion SHALL NOT publish anything, SHALL NOT modify the preset, and SHALL NOT create any lasting link between the preset and the draft.

#### Scenario: No publish path exists

- **WHEN** a user wants to share a custom preset's composition with another cell
- **THEN** the only path is authoring a pack draft — by hand in the creator editor or through the one-way conversion action; the custom-preset surface offers no publish or share affordance

#### Scenario: One-way bridge into authoring

- **WHEN** a user invokes the conversion action on a custom preset
- **THEN** a new pack draft is created in the author's cell, pre-filled per the pack-authoring conversion requirement, while the preset itself is untouched and remains cell-local

#### Scenario: Conversion never publishes

- **WHEN** the conversion action completes
- **THEN** nothing has been published to the marketplace and no pack version exists — only a private draft in the author's cell

### Requirement: Custom presets are foreign owners to packs

A pack install SHALL skip, with a reported reason, an agent entry whose id is held by a custom preset; the custom preset SHALL be untouched. The marketplace's one-directional never-overwrite-foreign-content policy SHALL treat custom presets as owners, the same as other packs.

#### Scenario: Pack install skips and reports

- **WHEN** a pack declaring an agent id held by a custom preset is installed
- **THEN** the install completes with that agent skipped and the report names the custom preset as the owner

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
