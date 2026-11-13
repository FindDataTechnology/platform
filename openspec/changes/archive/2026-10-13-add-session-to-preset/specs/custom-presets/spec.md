# custom-presets Delta

## MODIFIED Requirements

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
