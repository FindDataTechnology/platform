## ADDED Requirements

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
