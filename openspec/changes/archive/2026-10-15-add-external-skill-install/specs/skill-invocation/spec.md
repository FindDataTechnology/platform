## MODIFIED Requirements

### Requirement: Database custom skills hot-reload at runtime
The server SHALL reflect runtime mutations to database custom skills (create/update/delete via the management API) by writing, rewriting, or deleting the corresponding `SKILL.md` file in the `dsh-skill-filesystem`-watched materialization directory. A skill that carries auxiliary files SHALL materialize as a complete directory — the SKILL.md plus every stored auxiliary file at its recorded relative path — and a skill without them SHALL materialize as the single SKILL.md it always was. The `dsh-skill-filesystem` Chokidar watcher SHALL pick up the change live so the agent sees the updated skill **without a dsh process restart**, matching file-skill semantics.

#### Scenario: database skill created at runtime
- **WHEN** a new custom skill is created via the management API
- **THEN** the server SHALL write a new `SKILL.md` to the watched materialization directory
- **AND** the new skill SHALL become available to the agent session without a process restart

#### Scenario: database skill edited at runtime
- **WHEN** an existing custom skill is updated via the management API
- **THEN** the server SHALL rewrite the corresponding `SKILL.md` (atomic temp+rename)
- **AND** the agent session SHALL see the updated skill content without a process restart

#### Scenario: database skill deleted at runtime
- **WHEN** a custom skill is deleted via the management API
- **THEN** the server SHALL remove the skill's materialized directory (SKILL.md, and any auxiliary files with it) from the materialization directory
- **AND** the skill SHALL no longer be available to the agent session without a process restart

#### Scenario: materialization directory is rebuilt from the database on startup
- **WHEN** the server starts and the materialization directory is absent or stale
- **THEN** the server SHALL rebuild it idempotently from the SQLite custom-skills table
- **AND** the materialization directory SHALL be a gitignored runtime artifact under `PLATFORM_DATA_DIR`

#### Scenario: multi-file skill materializes its whole tree
- **WHEN** a skill carrying auxiliary files is created or updated
- **THEN** its materialized directory SHALL contain the SKILL.md plus every stored auxiliary file at its recorded relative path
- **AND** a stale auxiliary file no longer present in the stored set SHALL be removed from the directory

## ADDED Requirements

### Requirement: Materialized skill documents preserve stored frontmatter fields

The runtime's filesystem skill provider consumes frontmatter fields beyond name and description — notably `whenToUse`, `user-invocable`, `disable-model-invocation`, and a `metadata` object — and silently drops a whole skill whose invocation keys use legacy camelCase spellings. Materialization of a custom skill SHALL preserve the skill's stored frontmatter fields rather than regenerating a name/description-only header: for a skill carrying stored upstream frontmatter, every field from the stored set SHALL survive to the materialized file (with name and description normalized to the platform record's values), and the platform SHALL NOT introduce frontmatter keys the runtime rejects. For a skill without stored frontmatter (every pre-existing record, and user-authored skills), materialization SHALL keep the existing name/description-only header unchanged.

#### Scenario: upstream frontmatter survives materialization

- **WHEN** an installed external skill's upstream SKILL.md declared `whenToUse` (or `user-invocable`, `disable-model-invocation`, `metadata`)
- **THEN** the materialized SKILL.md retains those fields, and the runtime's skill entry exposes them (the skill is not silently stripped of its invocation policy)

#### Scenario: platform record name and description win

- **WHEN** a stored skill's frontmatter name differs from the platform record's name
- **THEN** the materialized frontmatter carries the platform record's name and description, and the upstream original name remains visible in the record's provenance

#### Scenario: keys the runtime rejects are never introduced

- **WHEN** a skill is materialized
- **THEN** its frontmatter contains none of the legacy camelCase invocation keys the runtime throws on, so the skill is never dropped as "unsupported frontmatter field"

#### Scenario: records without stored frontmatter keep the old header

- **WHEN** a record without stored frontmatter (a pre-existing row or a user-authored skill) is materialized
- **THEN** its SKILL.md carries exactly the name/description header it carried before this change
