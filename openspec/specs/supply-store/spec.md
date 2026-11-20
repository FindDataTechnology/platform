# supply-store Specification

## Purpose
The physical supply spine store: exactly one physical registration store (on the facet side) for the skill and MCP species — entries, visibility/groups, tool snapshots, supply annotations, provenance — with a single write gate, the registry serving as a read-through execution adapter over a local replica, its HTTP API preserved as a compat facade, and the migration/cutover/rollback discipline that retires the second registration store without changing any externally observable gateway behavior.

## Requirements

### Requirement: One physical registration store for skill and MCP species

All registration records for the `skill` and `mcp` species — entry identity, visibility and group membership, tool-list snapshots, supply annotations, provenance — SHALL be physically stored in the spine store on the facet side, and every write SHALL pass through the single spine write gate carrying identity and audit. No other store SHALL accept registration writes: any legacy registration store SHALL be read-only after cutover, and a write attempted against it SHALL fail structurally and raise an audit signal. The spine store SHALL NOT restate admission rules: admission stays with each species' own truth (skills and MCP servers admit via the visibility model; packs via the market listing rule).

#### Scenario: A registration write lands exactly once

- **WHEN** a registration or visibility change is submitted through the spine write gate
- **THEN** exactly one physical record is written in the spine store with the acting identity and an audit trail, and no other store receives a copy written by an independent writer

#### Scenario: A legacy direct write is refused

- **WHEN** a write is attempted directly against the retired registration store after cutover
- **THEN** the write fails structurally and the attempt is recorded as an audit signal, not silently accepted

### Requirement: The registry serves from a pulled read-only replica

The registry execution plane (gateway routing, health probing, tool proxying, token services) SHALL read registration data from a local read-only replica that is overwritten only by pulls from the spine's read-only projection on the registry's existing refresh cadence. The replica SHALL be marked stale honestly when a pull fails, continuing to serve the previous copy rather than an empty or invented state. The registry SHALL NOT hold a second write path: no registry-side mutation of registration records exists after cutover.

#### Scenario: A spine write reaches the gateway within the refresh window

- **WHEN** a server entry is updated through the spine gate and the registry's next pull completes
- **THEN** the gateway routes and presents the updated entry, and no independent write occurred on the registry side

#### Scenario: The spine is unreachable

- **WHEN** a scheduled pull fails
- **THEN** the registry continues serving the previous replica and its health/status surface reports the stale freshness explicitly rather than an invented healthy value

### Requirement: The registry HTTP API is a compat facade over the spine

The registry's HTTP API surface SHALL be preserved with byte-compatible shapes for existing consumers — the facet bridge, reconciliation and export scripts, and the 壹座 credential flows — during and after the migration. Read semantics SHALL serve from the spine projection; write semantics SHALL forward to the spine write gate and return the gate's audit and validation results as-is. A consumer that worked against the registry's own store before cutover SHALL work unchanged after cutover, and any consumer-visible error SHALL carry the same status and semantics classes as before.

#### Scenario: An existing reconciliation script runs unchanged

- **WHEN** the registry reconciliation script performs its read-and-compare pass after cutover
- **THEN** it completes against the unchanged registry API surface with results consistent with the spine store's content

#### Scenario: A facade write is audited at the gate

- **WHEN** a registration write arrives through the preserved registry API
- **THEN** it is forwarded to the spine write gate, and the response carries the gate's validation result and the write is audited with the acting identity exactly as if submitted to the gate directly

### Requirement: Visibility is native spine data

Group membership and visibility SHALL be native fields of the spine store, decided at the spine and projected to every consuming surface (registry routing, facet cards, plaza export, machine faces). The legacy manual group-mapping artifact and any bridge-side fail-open compensation for missing visibility metadata SHALL be retired: when a projection omits visibility data, the consuming surface SHALL fail closed rather than fall open.

#### Scenario: A group-gated server is invisible anonymously

- **WHEN** a server entry carries a required group in the spine store and an anonymous projection is generated
- **THEN** the entry is absent from the anonymous projection on every consuming surface

#### Scenario: A legacy mapping write has no effect

- **WHEN** the retired manual group-mapping artifact is edited after cutover
- **THEN** no consuming surface changes behavior, because visibility is decided solely by the spine store

### Requirement: Migration reconciles before cutover and can roll back

The migration from the legacy registration store to the spine store SHALL reconcile row counts and per-field content for every migrated record before cutover, with unknown fields reported as errors rather than silently dropped. A pre-cutover full dump SHALL be taken on both sides before the registry's read source is switched. Rollback SHALL repoint the registry's read source to its pre-cutover dump-backed local store within the retention window, and writes accepted by the spine during a rollback window SHALL be reconciled back before the legacy store is archived.

#### Scenario: Migration catches a field mismatch

- **WHEN** the migration encounters a record field absent from its enumerated field map
- **THEN** the migration aborts with the record and field named, and no cutover occurs until the map is corrected

#### Scenario: Cutover rolls back

- **WHEN** post-cutover regression fails during the observation window
- **THEN** the registry is repointed to its local store, gateway behavior returns to pre-cutover semantics, and spine-side writes from the rollback window are reconciled before archive

### Requirement: Partial metadata patches merge per key

A patch to a registration row's `metadata` SHALL merge key-by-key into the stored object rather than replace it whole: a caller that supplies one metadata key SHALL NOT thereby delete the keys it did not mention, because sibling keys carry live routing semantics (`supported_transports`, `surface`, `credential_ref`, `surface_source`, `surface_report_token_hash`) whose silent loss surfaces only much later as an unroutable path. An explicitly null value for a metadata key SHALL remove that key from the stored object, so intent to delete remains expressible. A patch whose `metadata` field is itself null SHALL clear the column, and a non-object `metadata` SHALL replace the stored value as a whole, both as before. Every patch SHALL continue to pass the write gate (identified actor, known field set, audited write), and the audited record SHALL be the merged entry as written.

#### Scenario: A single-key metadata patch preserves its siblings

- **WHEN** a patch supplies only `metadata.surface` for a row whose metadata also carries `supported_transports`, `credential_ref` and `surface_report_token_hash`
- **THEN** the stored metadata afterwards holds the new `surface` together with all three untouched keys

#### Scenario: An explicitly null key is deleted

- **WHEN** a patch supplies `metadata.supported_transports` with a null value
- **THEN** that key is absent from the stored metadata afterwards, and no other key changes

#### Scenario: Whole-column clear still works

- **WHEN** a patch supplies `metadata` itself as null
- **THEN** the stored metadata is null, matching the pre-change whole-value semantics

#### Scenario: Non-object metadata still replaces

- **WHEN** a patch supplies a metadata value that is not an object
- **THEN** it replaces the stored value whole rather than merging into it

#### Scenario: Unknown patch fields are still reported

- **WHEN** a patch names a field outside the patchable set
- **THEN** the write is rejected with the unknown-field error and the row is unchanged, as before
