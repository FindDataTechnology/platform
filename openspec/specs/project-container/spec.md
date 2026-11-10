# project-container Specification

## Purpose
Establishes Project as the web-side top-level container: a persisted server-side entity with identity (id + display name) that sessions, knowledge-base collections, and scheduled tasks attribute to — while the workspace path remains the engine-facing contract unchanged.

## Requirements

### Requirement: A project is a persisted entity, not just a directory name
The server SHALL maintain a projects store keyed by a stable id, each record carrying display name, backing directory path, owner, and created/updated timestamps. `POST /api/projects` SHALL create the record together with its directory; the store SHALL expose a list endpoint returning `{ id, name, path }` per project. A rename SHALL change only the display name; the backing path SHALL NOT move or change.

#### Scenario: create yields a stable id
- **WHEN** a client creates a project by name
- **THEN** the response carries an id that the project keeps across renames and process restarts

#### Scenario: rename does not disturb the path
- **WHEN** the user renames a project
- **THEN** the record's path is unchanged and no runtime or workspace switch is triggered

### Requirement: Sessions, collections, and scheduled tasks carry an optional project attribution
`chat_sessions`, document collections, and cron jobs SHALL each carry a nullable project reference. New rows created while a project context is active SHALL be stamped with that project's id; rows created without one (including all desktop-origin rows) SHALL remain NULL. Attribution is additive: no existing column, key, or API field is repurposed.

#### Scenario: web session under a project is attributed
- **WHEN** a session's first turn is mirrored while the active web project context is P
- **THEN** the session row references P

#### Scenario: unattributed rows stay unattributed
- **WHEN** a session, collection, or job exists with no project reference (legacy data or desktop origin)
- **THEN** it remains valid and renders under the fallback group without migration

#### Scenario: attribution never gates engine behavior
- **WHEN** any row is stamped, changed, or cleared of a project reference
- **THEN** the runtime workspace contract (path validation, cwd, restart semantics) is untouched

### Requirement: The default project is a fallback view, not a stored assignment
The web surfaces SHALL present unattributed sessions, collections, and tasks under a "默认项目" group derived at read time. Historical rows SHALL NOT be rewritten into a real default-project record; clearing or lacking attribution is always representable.

#### Scenario: legacy content groups under 默认项目
- **WHEN** the web project list is rendered and unattributed rows exist
- **THEN** they appear under a read-time 默认项目 group, distinguishable from real projects (e.g., not renamable/deletable as a project)

### Requirement: Web groups by project; desktop keeps directory grouping
The web surface SHALL present Project as the top-level organizing concept for sessions, knowledge collections, and scheduled tasks. The desktop surface SHALL keep the existing directory-grouped session organization with unchanged behavior. The fork SHALL follow the established desktop/web surface distinction; no deployment can make the desktop present path-less grouping or the web lose project grouping.

#### Scenario: identical data renders differently per surface
- **WHEN** the same account with a mixed session list is opened on web and on desktop
- **THEN** web groups sessions by project (attributed) with the 默认项目 fallback, and desktop groups them by workspace path exactly as today

#### Scenario: desktop-origin sessions are not force-attributed
- **WHEN** a user creates and runs sessions on desktop
- **THEN** no project id is written for those rows, and web sees them under 默认项目
