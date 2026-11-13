## MODIFIED Requirements

### Requirement: Server loads skills from configured paths
The server SHALL point dsh's `dsh-skill-filesystem` plugin at a local skills directory (`customSkillDirs`) so that skills are loaded into the agent's system prompt and slash-command table at startup. The server SHALL also load custom skill definitions from the SQLite database (if present) by **materializing each as a `SKILL.md` file into a `dsh-skill-filesystem`-watched directory**, so they are registered alongside file-based skills AND hot-reloaded at runtime when edited.

#### Scenario: skills are loaded at startup
- **WHEN** the skills directory contains one or more `SKILL.md` files
- **THEN** the `dsh-skill-filesystem` plugin SHALL discover and load those skills
- **AND** the loaded skills SHALL be available to the agent session

#### Scenario: no skills directory
- **WHEN** the configured skills directory is empty or absent
- **THEN** the server SHALL start normally with no file skills loaded

#### Scenario: database custom skills are loaded and materialized
- **WHEN** the SQLite database contains custom skill definitions
- **THEN** the server SHALL materialize each custom skill as a `SKILL.md` file into a watched directory
- **AND** database skills SHALL be available to the agent session alongside file-based skills

## ADDED Requirements

### Requirement: Database custom skills hot-reload at runtime
The server SHALL reflect runtime mutations to database custom skills (create/update/delete via the management API) by writing, rewriting, or deleting the corresponding `SKILL.md` file in the `dsh-skill-filesystem`-watched materialization directory. The `dsh-skill-filesystem` Chokidar watcher SHALL pick up the change live so the agent sees the updated skill **without a dsh process restart**, matching file-skill semantics.

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
- **THEN** the server SHALL remove the corresponding `SKILL.md` from the materialization directory
- **AND** the skill SHALL no longer be available to the agent session without a process restart

#### Scenario: materialization directory is rebuilt from the database on startup
- **WHEN** the server starts and the materialization directory is absent or stale
- **THEN** the server SHALL rebuild it idempotently from the SQLite custom-skills table
- **AND** the materialization directory SHALL be a gitignored runtime artifact under `PLATFORM_DATA_DIR`
