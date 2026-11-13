## MODIFIED Requirements

### Requirement: Files enter the library by explicit save, and saved bytes are durable copies

A file SHALL become a resource by explicit user action, and only files produced inside the agent workspace SHALL be savable (uploads and documents already have an owning library and SHALL NOT be duplicated here). Explicit saving SHALL copy the file's bytes into the resources data directory under a path derived from the resource id, so the resource survives later changes to the workspace; the resource SHALL record the original workspace-relative path, the byte size, and a content hash. A same-content save SHALL NOT create a duplicate entry. A file exceeding the configured per-resource size cap SHALL be refused with a clear error and nothing SHALL be copied. Saving a file whose source no longer exists SHALL fail with a clear error. Deleting a file resource SHALL remove both the row and the stored bytes.

#### Scenario: saving a generated file makes it durable

- **WHEN** the user saves a workspace file as a resource
- **THEN** the bytes are copied into the resources data directory
- **AND** the resource can be previewed and downloaded even after the workspace file is modified or removed

#### Scenario: saving the same file twice does not duplicate it

- **WHEN** the user saves a file whose content hash already exists in the library
- **THEN** no new resource is created
- **AND** the user is told it is already in the library

#### Scenario: oversize and missing sources are refused

- **WHEN** the user saves a file larger than the size cap, or one that no longer exists in the workspace
- **THEN** the save fails with a message naming the reason
- **AND** no partial bytes are left in the resources directory

## ADDED Requirements

### Requirement: Files a turn produced are captured into the library automatically

Every assistant turn mirrored to the project database SHALL be examined for produced files, and each produced file that passes the gate SHALL be recorded as a `file` resource with `source=auto` and no user action. Which files a turn produced SHALL follow the shared produced-file rule (the same rule the chat clients apply). Each candidate SHALL be gated before capture: its path SHALL resolve inside the agent workspace (lexical containment and realpath), the target SHALL be a regular file within the per-resource size cap, and candidates that fail SHALL be skipped. Capture SHALL store a durable copy of the bytes and the turn's provenance (session id, session title snapshot, message id), deduplicated by content hash across the cell: a candidate whose bytes are already in the library SHALL NOT create a second entry — its last-seen time is refreshed; bytes that differ SHALL create a new row. Capture SHALL apply to every lane that mirrors turns (interactive clients, scheduled tasks, delegation), because it rides the shared mirror funnel. A capture failure SHALL be logged and SHALL NOT fail the message mirror.

#### Scenario: a turn-produced archive appears in Outputs without user action

- **WHEN** an assistant turn's shell call produces an archive in the workspace
- **THEN** a `file` resource for it exists in the library with `source=auto`
- **AND** the Outputs Files panel lists it with the turn's session provenance

#### Scenario: candidates outside the workspace are refused

- **WHEN** the produced-file rule yields a path outside the agent workspace (for example a redirect into `/tmp`)
- **THEN** no resource is created for it

#### Scenario: same bytes refresh, changed bytes add

- **WHEN** a later turn produces a file whose content hash already exists in the library
- **THEN** no second row is created and the existing row's last-seen time is refreshed
- **WHEN** the same path is produced again with different bytes
- **THEN** a new row is created and the earlier row is preserved

#### Scenario: capture never fails the mirror

- **WHEN** the capture path encounters an error (unreadable file, storage failure, unexpected exception)
- **THEN** the assistant message is still mirrored to the database unchanged
- **AND** the failure is logged server-side

#### Scenario: scheduled-task and delegation turns are captured

- **WHEN** a scheduled task or delegation turn produces a workspace file
- **THEN** the file is captured by the same path as interactive turns
