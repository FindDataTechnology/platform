## Purpose

A durable, typed library of artifacts produced in chat — charts and generated files today, further types by extension — captured from the conversation but owned by the user, independent of any session's lifecycle.

## ADDED Requirements

### Requirement: Resources are typed artifacts with provenance

The system SHALL persist resources in the project database as typed rows. Every resource SHALL carry a `type` (v1: `chart`, `file`), a title, a creation source (`auto` capture or `manual` save), and its provenance: the originating session id, a snapshot of that session's title at capture time, and the originating message reference when one exists. Session linkage SHALL be a soft reference that does not cascade: deleting a session SHALL NOT delete its resources, and a resource whose session no longer exists SHALL remain fully readable. Type-specific content SHALL live in an extensible payload (JSON for types that are self-contained, an optional stored-bytes reference for files) so a new type can be added without restructuring existing rows.

#### Scenario: a captured chart carries its provenance

- **WHEN** a chart is captured from an assistant message during a turn in session S
- **THEN** the resource records the session id, the session title as it stood at capture time, and the originating message reference

#### Scenario: deleting the source session does not delete resources

- **WHEN** the user deletes the session a resource came from
- **THEN** the resource remains listed and readable
- **AND** its provenance still shows the session title snapshot
- **AND** any jump-to-session affordance for it is absent or disabled

### Requirement: Chart specs are captured automatically from assistant turns

Every complete assistant turn SHALL be examined for chart specifications, and each one found SHALL be recorded as a resource with no user action. The recognized form SHALL be the existing chart contract: a fenced `echarts` block whose body parses as a JSON object (the same rule the chat renderers apply; a fence that fails to parse is not a chart and SHALL NOT be captured). Capture SHALL happen where turns are mirrored to the project database, so it applies uniformly to turns from every client and from scheduled-task runs. Charts SHALL be deduplicated by content hash across the whole cell: a spec already in the library SHALL NOT create a second entry — its last-seen time is refreshed instead, and the original provenance is kept. Regenerating a turn (an honest re-send, since the runtime has no replace-turn operation) therefore never duplicates charts. The chart's title SHALL default to the option's own title text when present, and to a session-derived label otherwise; retitling is possible afterwards.

#### Scenario: a chart in an assistant turn is captured without user action

- **WHEN** an assistant turn completes containing a well-formed fenced `echarts` block
- **THEN** a `chart` resource exists with the parsed option as its payload
- **AND** the user did not take any action to create it

#### Scenario: malformed or partial fences are not captured

- **WHEN** an assistant turn contains a fence tagged `echarts` whose body does not parse as a JSON object
- **THEN** no resource is created for it
- **AND** the chat renders it as an ordinary code block, unchanged

#### Scenario: an identical spec never creates a second entry

- **WHEN** the same chart spec is produced again — in another turn, another session, or a regenerated answer
- **THEN** the library still holds exactly one resource for that spec
- **AND** that resource's last-seen time is refreshed

#### Scenario: charts from scheduled-task turns are captured too

- **WHEN** a scheduled task's turn produces a chart
- **THEN** the chart is captured by the same rule as an interactive turn

### Requirement: Files enter the library by explicit save, and saved bytes are durable copies

A file SHALL become a resource only by explicit user action, and only files produced inside the agent workspace SHALL be savable (uploads and documents already have an owning library and SHALL NOT be duplicated here). Saving SHALL copy the file's bytes into the resources data directory under a path derived from the resource id, so the resource survives later changes to the workspace; the resource SHALL record the original workspace-relative path, the byte size, and a content hash. A same-content save SHALL NOT create a duplicate entry. A file exceeding the configured per-resource size cap SHALL be refused with a clear error and nothing SHALL be copied. Saving a file whose source no longer exists SHALL fail with a clear error. Deleting a file resource SHALL remove both the row and the stored bytes.

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

### Requirement: Resource management API

The cell SHALL expose a REST surface for the library: list (with type filtering, text search over titles, and pagination), save a workspace file, rename, and delete. Chart payloads SHALL be included in list responses so a client can render charts without a second request. Every mutation SHALL be reflected to connected clients of that cell as a library-change event, so open lists and counts reconcile without a manual reload. Requests that are not authenticated as the cell's user SHALL be rejected by the existing cell auth gate. All routes SHALL be accessible with the same credentials as the rest of the client API — no new auth mechanism is introduced.

#### Scenario: list, filter, and search

- **WHEN** a client lists resources with a type filter or a title query
- **THEN** only matching resources are returned, most recent first, with pagination metadata

#### Scenario: rename and delete round-trip

- **WHEN** a client renames a resource
- **THEN** the new title is persisted and included in subsequent listings
- **WHEN** a client deletes a resource
- **THEN** it disappears from listings and its stored bytes (for files) are removed

#### Scenario: an open client sees a capture arrive

- **WHEN** a chart is captured while a client has the library open
- **THEN** the client receives the library-change event and can show it without a manual reload

### Requirement: Stored bytes are served through the existing rooted file route

Stored file bytes SHALL be served by the existing read-only file route with a third configured root pointing at the resources data directory, so the route's existing guarantees — real-path containment, symlink escape rejection, absolute-path rejection, `404` for missing files, inline-versus-download disposition by type — apply unchanged. The resources root SHALL be write-protected in the sense that only the save path writes to it; the serving route SHALL remain strictly read-only.

#### Scenario: a stored file is served like any other rooted file

- **WHEN** a client requests a stored resource file through the file route with the resources root
- **THEN** the bytes are returned with the same disposition rules as workspace and uploads files

#### Scenario: traversal attempts against the resources root are rejected

- **WHEN** a request against the resources root contains `..` segments, an absolute path, or a symlink escaping the root
- **THEN** the request is rejected without reading anything outside the root

### Requirement: Charts already in history can be seeded into the library

A seeding path SHALL exist that scans previously recorded assistant messages and captures their chart fences by the same parse and dedupe rules, so charts produced before the library existed are not lost. Automatic seeding SHALL run at most once per cell, guarded by a completion marker; an explicit operator invocation may re-run it at any time (which may re-create entries a user had deleted — a documented consequence of the manual re-run, never of the automatic one).

#### Scenario: upgrade seeds existing charts

- **WHEN** a cell upgrades to a version with the library and the seeding has never run
- **THEN** charts found in previously recorded assistant messages appear in the library

#### Scenario: the automatic seeding never repeats

- **WHEN** the cell restarts after a seeding run completed
- **THEN** no second automatic seeding occurs
- **AND** resources deleted in the meantime are not resurrected