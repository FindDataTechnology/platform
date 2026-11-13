# resource-library-ui Delta

## MODIFIED Requirements

### Requirement: Saving a file from the web chat
The web chat SHALL expose a save-to-resources action for files it already recognizes as workspace files — from the preview drawer and the turn artifact strip at minimum — without requiring the user to leave the conversation. On success the user SHALL receive confirmation; when the library already holds the same content, the action SHALL report that instead of creating a duplicate. A failed save SHALL surface the reason (for example: too large, or the file no longer exists).

#### Scenario: save from the preview drawer
- **WHEN** the user opens a workspace file in the preview drawer and activates save-to-resources
- **THEN** the file is stored and a confirmation appears
- **AND** the resource is immediately visible on the resources page

#### Scenario: save from the turn artifact strip
- **WHEN** the user activates save-to-resources on a file entry in the turn artifact strip
- **THEN** the file is stored and a confirmation appears
- **AND** the entry's save state updates to already-in-library without a page reload

#### Scenario: already in the library
- **WHEN** the user saves a file whose content is already stored
- **THEN** no duplicate is created and the user is told it is already in the library

## ADDED Requirements

### Requirement: Web chat surfaces turn artifacts in a strip
After each assistant turn, the web chat SHALL surface an aggregated strip of the files that turn's tool calls produced or modified. The strip's file set SHALL be derived from tool call paths (never from workspace scanning), deduplicated by path, and shown at latest state. Each strip entry SHALL display a save state — not in library, or already in library by content — and offer preview and save-to-library actions. The strip SHALL be synthesized at render time only: it SHALL never be persisted into message content, SHALL never enter model-visible history, and SHALL render identically for historical sessions.

#### Scenario: unlinked file still surfaces
- **WHEN** a turn's tool call writes a workspace file and the assistant's text references it only in prose or not at all
- **THEN** the turn artifact strip lists that file with preview and save actions

#### Scenario: save state reflects library membership
- **WHEN** a strip entry's file content is already in the library
- **THEN** the entry displays the already-in-library state and a save attempt reports no duplicate

#### Scenario: repeated writes to the same path dedupe
- **WHEN** a turn's tool calls write the same path multiple times, or a file is rewritten across turns
- **THEN** the strip shows one entry per path at its latest state

#### Scenario: the strip is synthesized, never persisted
- **WHEN** a message with a turn artifact strip is reloaded or exported
- **THEN** the stored message content is unchanged and contains no strip markup
- **AND** the model's view of the conversation history does not include the strip

#### Scenario: historical session renders the strip
- **WHEN** a past session is reopened and its turns' tool blocks record file paths
- **THEN** those turns render the turn artifact strip derived from the recorded tool data
