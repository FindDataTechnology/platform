# resource-library Specification (delta)

## MODIFIED Requirements

### Requirement: Resources are typed artifacts with provenance

The system SHALL persist resources in the project database as typed rows. Every resource SHALL carry a `type` (v1: `chart`, `file`), a title, a creation source (`auto` capture or `manual` save), and its provenance: the originating session id, a snapshot of that session's title at capture time, and the originating message reference when one exists. Session linkage SHALL be a soft reference that does not cascade: deleting a session SHALL NOT delete its resources, and a resource whose session no longer exists SHALL remain fully readable. Type-specific content SHALL live in an extensible payload (JSON for types that are self-contained, an optional stored-bytes reference for files) so a new type can be added without restructuring existing rows. A chart resource MAY reference one or more chart data bindings (one per rendered series); the reference is to the binding as a data source and does not extend the resource's session provenance.

#### Scenario: a captured chart carries its provenance

- **WHEN** a chart is captured from an assistant message during a turn in session S
- **THEN** the resource records the session id, the session title as it stood at capture time, and the originating message reference

#### Scenario: deleting the source session does not delete resources

- **WHEN** the user deletes the session a resource came from
- **THEN** the resource remains listed and readable
- **AND** its provenance still shows the session title snapshot
- **AND** any jump-to-session affordance for it is absent or disabled

#### Scenario: a multi-series chart holds one binding per series

- **WHEN** a chart resource renders two series and each series is bound to a data source
- **THEN** the resource references two bindings, one per series

#### Scenario: binding references do not outlive their resource

- **WHEN** the last resource referencing a binding is deleted
- **THEN** the binding is no longer referenced by any resource and the cleanup path applies

### Requirement: Chart specs are captured automatically from assistant turns

Every complete assistant turn SHALL be examined for chart specifications, and each one found SHALL be recorded as a resource with no user action. The recognized form SHALL be the existing chart contract: a fenced `echarts` block whose body parses as a JSON object (the same rule the chat renderers apply; a fence that fails to parse is not a chart and SHALL NOT be captured). Capture SHALL happen where turns are mirrored to the project database, so it applies uniformly to turns from every client and from scheduled-task runs. Charts SHALL be deduplicated by content hash across the whole cell: a spec already in the library SHALL NOT create a second entry — its last-seen time is refreshed instead, and the original provenance is kept. Regenerating a turn (an honest re-send, since the runtime has no replace-turn operation) therefore never duplicates charts. The chart's title SHALL default to the option's own title text when present, and to a session-derived label otherwise; retitling is possible afterwards. For every captured chart, the capture path SHALL also retain the MCP tool calls that executed in the same turn (their exact names, arguments, and results) as binding candidates; a candidate SHALL be retained even when no binding is created from it, and SHALL be the only source of candidates later offered to the user. The turn's tool-call record SHALL NOT be treated as a binding by itself — attaching a binding always requires one of the binding creation sources defined by the chart-data-binding capability.

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

#### Scenario: same-turn MCP calls are retained as binding candidates

- **WHEN** an assistant turn draws a chart from an MCP call and the chart is captured
- **THEN** the capture records that call's exact name, arguments, and result as a binding candidate for the chart
- **AND** the candidate does not by itself attach any binding

### Requirement: Resource management API

The cell SHALL expose a REST surface for the library: list (with type filtering, text search over titles, and pagination), save a workspace file, rename, and delete. Chart payloads SHALL be included in list responses so a client can render charts without a second request. Every mutation SHALL be reflected to connected clients of that cell as a library-change event, so open lists and counts reconcile without a manual reload. For bound charts the surface SHALL additionally expose: attach a binding (from a retained candidate), detach a binding, trigger a refresh, set a binding's refresh rule (TTL and cron), and list a bound chart's observation timeline with its as-of reconstruction query — each mutation broadcast through the same library-change event mechanism. Requests that are not authenticated as the cell's user SHALL be rejected by the existing cell auth gate. All routes SHALL be accessible with the same credentials as the rest of the client API — no new auth mechanism is introduced.

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

#### Scenario: binding mutations round-trip through the API

- **WHEN** a client attaches a binding from a retained candidate, sets a refresh rule, and triggers a refresh
- **THEN** all three are reflected in the resource's subsequent listings
- **AND** the observation timeline endpoint returns the refresh that just ran

#### Scenario: an unauthenticated refresh request is rejected

- **WHEN** a request to any of the binding or refresh routes arrives without the cell's identity
- **THEN** it is rejected by the existing auth gate, not by new logic
