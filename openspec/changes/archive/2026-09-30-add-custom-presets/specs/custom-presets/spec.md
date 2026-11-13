## Purpose

User-composed persona presets: any authenticated user assembles a conversational role from locally-available resources on their own cell — focused by construction, cell-local by design.

## ADDED Requirements

### Requirement: Custom presets are created and managed in the cell

Authenticated users SHALL be able to create, edit, and delete custom presets, each carrying a display name, persona text, and optional tags and icon — persona-only, with no endpoint, model, or credential fields in the editor or the stored row. Preset ids SHALL be server-assigned under the reserved `user.` prefix; authors choose display names, never ids. The roster SHALL be deployment-global state of the shared runtime: every connected client sees the same presets, and any authenticated user may manage them. Management mutations SHALL follow the serialized runtime-mutation path (catalog refresh, idle-runtime restart) and SHALL be rejected while a turn is streaming.

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

A custom preset SHALL NOT be publishable to the marketplace and SHALL NOT appear in any marketplace surface; it exists only in its cell's roster. Sharing a composition SHALL go through authoring a pack draft in the marketplace's creator path, never through a local preset gaining a publish action.

#### Scenario: No publish path exists

- **WHEN** a user wants to share a custom preset's composition with another cell
- **THEN** the only path is recreating it as a pack draft in the creator editor; the custom-preset surface offers no publish, export, or share affordance

### Requirement: Custom presets are foreign owners to packs

A pack install SHALL skip, with a reported reason, an agent entry whose id is held by a custom preset; the custom preset SHALL be untouched. The marketplace's one-directional never-overwrite-foreign-content policy SHALL treat custom presets as owners, the same as other packs.

#### Scenario: Pack install skips and reports

- **WHEN** a pack declaring an agent id held by a custom preset is installed
- **THEN** the install completes with that agent skipped and the report names the custom preset as the owner
