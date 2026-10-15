# file-persistence Specification

## Purpose
TBD - created by syncing change unify-persistence. Update Purpose after archive.

## Requirements

### Requirement: Atomic durable writes for file-based stores
The shared persistence module SHALL provide atomic write functions for JSON and text files that write to a uniquely-named temporary file in the target directory, fsync the file before renaming it over the target, and leave no temporary files behind on success. Concurrent writes to the same target SHALL NOT use colliding temporary paths.

#### Scenario: write produces exact bytes atomically
- **WHEN** a store saves a value via the shared atomic write
- **THEN** the target file SHALL contain byte-identical output to the pre-existing per-store formatting (`JSON.stringify(value, null, 2)` for JSON, existing YAML dump for text sites)
- **AND** no `*.tmp` file SHALL remain in the directory

#### Scenario: concurrent saves do not collide on temp paths
- **WHEN** two saves to the same file are in flight simultaneously
- **THEN** each SHALL use a distinct temporary file name and the final content SHALL be the result of the last completed save

### Requirement: Per-store serialized mutations
File-backed stores exposed through the store wrapper SHALL serialize load-mutate-save cycles: concurrent mutations to the same store SHALL be applied in order with none lost, in place of the previous unlocked full-file rewrite behavior (notably cron job add/remove/pause/resume).

#### Scenario: concurrent cron add and remove
- **WHEN** a job add and a job remove are issued concurrently
- **THEN** both mutations SHALL be durably reflected in the jobs file (no lost update, no corrupt file)

### Requirement: Single read-fallback policy
Reads of optional JSON files SHALL share one helper: missing file returns the fallback; unreadable or unparsable content logs a warning identifying the path and returns the fallback. The helper SHALL NOT throw for any pre-existing-file condition.

#### Scenario: corrupt store file
- **WHEN** a store file contains invalid JSON
- **THEN** the reader SHALL log a warning naming the file and return the provided fallback instead of crashing the server

### Requirement: Shared identity and timestamp helpers
New persistence call sites SHALL use the shared helpers for ISO timestamps (`nowIso`), identifier generation (`randomUUID`), and title truncation, replacing the per-module duplicates; existing on-disk formats produced by these helpers SHALL be unchanged.

#### Scenario: duplicated helpers removed
- **WHEN** the migration is complete
- **THEN** `truncateTitle` SHALL exist in exactly one module, and the dead `toIso` copy in chat-history SHALL be removed without behavior change
