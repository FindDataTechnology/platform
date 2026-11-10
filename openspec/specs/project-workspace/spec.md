# project-workspace Specification

## Purpose

Name-based project creation: a user names a project, the server creates a directory for it under a projects root, and the existing workspace-switch contract takes it from there — so non-technical users never handle absolute paths.

## Requirements

### Requirement: Server creates a project directory from a name

The server SHALL expose `POST /api/projects` accepting `{ name }`. It SHALL sanitize the name to a single path segment — trimming whitespace, collapsing internal whitespace to `-`, keeping CJK characters, letters, digits, hyphens and underscores, and rejecting empty results, results longer than 64 characters, and any name containing path separators or `..` — with HTTP 400 and a readable error. On a valid name it SHALL create the directory `<projectsRoot>/<sanitized>` (recursive, skipping creation when it already exists as a directory) where `<projectsRoot>` is the `PROJECTS_ROOT` environment value when set, else `<data directory>/projects`, and SHALL record a project entity (openspec: project-container) referencing that directory. It SHALL respond `{ id, path, name }` with `path` the absolute directory path and `id` the stable project id. Creating MUST NOT touch the running dsh runtime — switching to the new directory remains the client's separate `set_workspace` action with its full existing validation, confirmation, restart, and broadcast chain.

#### Scenario: create by name

- **WHEN** the client posts `{ "name": "季度报告" }`
- **THEN** the server SHALL create `<projectsRoot>/季度报告`, record the project entity, and respond with its stable id, absolute path and the sanitized name

#### Scenario: unsafe names are rejected

- **WHEN** the client posts a name containing `/`, `\`, or `..`, or an empty/over-long name
- **THEN** the server SHALL respond HTTP 400 with a readable error and create neither the directory nor the project record

#### Scenario: attaching to an existing project directory

- **WHEN** the client posts a name whose sanitized directory already exists
- **THEN** the server SHALL respond with that directory's absolute path, its project id, and the matching record without failing

#### Scenario: creating does not switch the runtime

- **WHEN** a project is created successfully
- **THEN** the dsh runtime's working directory SHALL be unchanged

#### Scenario: pre-existing rows reconcile by path

- **WHEN** a session, collection, or job was created with a workspace path under `<projectsRoot>` before a project record for that directory exists
- **THEN** listing projects SHALL resolve that path to the project record by backing path, so attribution by id and by path describe the same container
