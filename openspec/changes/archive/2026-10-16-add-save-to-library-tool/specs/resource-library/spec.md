# Delta: add-save-to-library-tool — resource-library

## MODIFIED Requirements

### Requirement: Files enter the library by explicit save, and saved bytes are durable copies

A file SHALL become a resource by explicit save — the user's save action from a chat surface, or the model's save tool during a turn — and only files produced inside the agent workspace SHALL be savable (uploads and documents already have an owning library and SHALL NOT be duplicated here). Every explicit save, from either channel, SHALL pass the same gate and take the same durable path: the file's bytes are copied into the resources data directory under a path derived from the resource id, so the resource survives later changes to the workspace; the resource SHALL record the original workspace-relative path, the byte size, and a content hash. A same-content save SHALL NOT create a duplicate entry. A file exceeding the configured per-resource size cap SHALL be refused with a clear error and nothing SHALL be copied. Saving a file whose source no longer exists SHALL fail with a clear error. Deleting a file resource SHALL remove both the row and the stored bytes.

#### Scenario: saving a generated file makes it durable

- **WHEN** the user saves a workspace file as a resource
- **THEN** the bytes are copied into the resources data directory
- **AND** the resource can be previewed and downloaded even after the workspace file is modified or removed

#### Scenario: a model save takes the same durable path

- **WHEN** the model saves a workspace file through the save tool
- **THEN** the bytes are copied by the same path as a user save, with a source value that distinguishes the model save

#### Scenario: saving the same file twice does not duplicate it

- **WHEN** the user saves a file whose content hash already exists in the library
- **THEN** no new resource is created
- **AND** the user is told it is already in the library

#### Scenario: oversize and missing sources are refused

- **WHEN** the user saves a file larger than the size cap, or one that no longer exists in the workspace
- **THEN** the save fails with a message naming the reason
- **AND** no partial bytes are left in the resources directory

## ADDED Requirements

### Requirement: The model saves files into the library through a turn tool

The cell SHALL expose a model-visible save tool that ingests workspace files into the library during the turn, so a delivered file reaches the library even when the automatic capture rule cannot recognize how it was produced. The tool SHALL accept a list of workspace paths (relative or absolute), at most 10 per call — excess paths SHALL be refused individually with a reason, not silently dropped — and SHALL refuse directories with a reason. The resource title SHALL default to the file name. Saving SHALL be immediate: no user confirmation gate stands between the tool call and the library entry, because the user's conversational request is the confirmation. Every path SHALL pass the same gate as an explicit save (workspace containment, size cap, content dedupe), and the tool SHALL return one result per path — saved, already-saved, or refused with a reason — so the model can report the outcome to the user. A save through the tool SHALL record session-level provenance (the current turn's session id and session title snapshot) without a message reference. The tool SHALL reach the platform over the cell's loopback bridge only: the route it calls SHALL accept loopback callers with no session credential and SHALL reject every non-loopback caller through the existing auth gate.

#### Scenario: a script-produced file reaches the library by tool

- **WHEN** a turn's script writes a file the automatic capture rule cannot recognize, and the model calls the save tool with its path
- **THEN** a `file` resource for it exists in the library with the turn's session provenance

#### Scenario: per-path results come back to the model

- **WHEN** the model calls the tool with three paths of which one is over the size cap
- **THEN** the tool returns two saved results and one refusal naming the reason
- **AND** the two saves stand; the refusal creates nothing

#### Scenario: an already-saved file reports instead of duplicating

- **WHEN** the tool saves a file whose content hash already exists in the library
- **THEN** the result is already-saved, no second row is created, and the existing row's last-seen time is refreshed

#### Scenario: the eleventh path is refused, not dropped

- **WHEN** the model calls the tool with 11 paths
- **THEN** the first 10 are processed normally and the 11th is refused with a reason naming the per-call cap

#### Scenario: a directory is refused

- **WHEN** the model calls the tool with a path that resolves to a directory
- **THEN** that path is refused with a reason and nothing is copied for it

#### Scenario: a non-loopback caller faces the full gate

- **WHEN** a request to the tool's route arrives from a non-loopback address
- **THEN** it is rejected by the existing auth gate, not by new logic
