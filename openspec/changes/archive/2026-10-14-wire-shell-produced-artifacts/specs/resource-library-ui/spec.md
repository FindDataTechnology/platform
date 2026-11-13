## MODIFIED Requirements

### Requirement: Web chat surfaces turn artifacts in a strip
After each assistant turn, the web chat SHALL surface an aggregated strip of the files that turn's tool calls produced or modified. The strip's file set SHALL be derived from the paths those tool calls produced (never from workspace scanning), deduplicated by path, and shown at latest state. Which calls count as producing a file SHALL follow the produced-file rule: a call that only read, listed, or searched contributes nothing, and a shell call contributes only the outputs its command declares. A candidate path SHALL be shown only when the file exists in the workspace. Each strip entry SHALL display a save state — not in library, or already in library by content — and offer preview and save-to-library actions. The strip SHALL be synthesized at render time only: it SHALL never be persisted into message content, SHALL never enter model-visible history, and SHALL render identically for historical sessions.

#### Scenario: unlinked file still surfaces
- **WHEN** a turn's tool call writes a workspace file and the assistant's text references it only in prose or not at all
- **THEN** the turn artifact strip lists that file with preview and save actions

#### Scenario: save state reflects library membership
- **WHEN** a strip entry's file content is already in the library
- **THEN** the entry displays the already-in-library state and a save attempt reports no duplicate

#### Scenario: repeated writes to the same path dedupe
- **WHEN** a turn's tool calls write the same path multiple times, or a file is rewritten across turns
- **THEN** the strip shows one entry per path at its latest state

#### Scenario: a shell-produced archive surfaces
- **WHEN** a turn's shell call produces an archive in the workspace and the assistant's text does not link it
- **THEN** the turn artifact strip lists the archive with preview and save actions

#### Scenario: read-only calls add nothing to the strip
- **WHEN** a turn's calls only read, list, or search files and produce nothing
- **THEN** the strip is absent for that turn rather than listing the files those calls named

#### Scenario: a candidate that no longer exists is not shown
- **WHEN** a produced path is no longer present in the workspace by the time the strip renders
- **THEN** the strip omits that entry

#### Scenario: the strip is synthesized, never persisted
- **WHEN** a message with a turn artifact strip is reloaded or exported
- **THEN** the stored message content is unchanged and contains no strip markup
- **AND** the model's view of the conversation history does not include the strip

#### Scenario: historical session renders the strip
- **WHEN** a past session is reopened and its turns' tool blocks record file paths
- **THEN** those turns render the turn artifact strip derived from the recorded tool data
