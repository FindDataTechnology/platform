# project-database 演进纪律

## ADDED Requirements

### Requirement: Schema growth is additive and guarded

New persisted stores SHALL be introduced only as additive entries in the `MIGRATIONS` array (`db.js`): one ordered, idempotent migration per change, recorded in `schema_migrations`, with no rewriting of earlier migrations. A migration that alters a table SHALL guard on that table's existence so a role-gated or legacy fixture database lacking the table skips the step instead of aborting the whole chain (`v110`/`v111` precedent). A migration failure SHALL leave `dbReady=false` with the graceful degradation already specified, and SHALL NOT partially apply a migration's statements.

#### Scenario: a new store lands behind an ordered migration
- **WHEN** a feature adds a new table to the project database
- **THEN** it SHALL be added as the next `MIGRATIONS` entry with a create-table statement
- **AND** startup SHALL apply it once, recording its version in `schema_migrations`

#### Scenario: a fixture lacking a table does not break the chain
- **WHEN** startup runs against a database whose role-gated fixture has no `collections` table
- **THEN** the `ALTER` migration SHALL detect the missing table and skip it
- **AND** the remaining migrations SHALL still apply and the server SHALL start with `dbReady=true`
