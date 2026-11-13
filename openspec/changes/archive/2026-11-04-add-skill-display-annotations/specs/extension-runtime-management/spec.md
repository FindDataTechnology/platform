# extension-runtime-management 增量（add-skill-display-annotations）

## MODIFIED Requirements

### Requirement: Backend API for managing skills at runtime

The server SHALL expose REST API endpoints to list, add, remove, enable, and disable skills without requiring a server restart. Each listed skill SHALL include its `origin` and `locked` flag. Locked bundled skills SHALL NOT be removable, disable-able, or editable via the API: such requests SHALL return 400. A skill record MAY additionally carry an auxiliary file set (a mapping of relative paths to text contents) and external-origin provenance metadata; a record without them behaves as a single-file skill exactly as before, and every existing record (pre-migration rows) SHALL remain in that single-file shape with unchanged behavior. The list endpoint SHALL expose each skill's auxiliary file inventory (paths only) and its external provenance when present, so clients can distinguish multi-file and externally-installed skills from locally authored ones. The add endpoint SHALL accept, alongside the single-document shape, a package upload parsed under the platform's package contract — path safety, text-only admission, per-file and aggregate bounds, script inventory — rejecting a violating package with a named cause and creating nothing; the update endpoint SHALL replace a skill's auxiliary file set and stored frontmatter wholesale when they are present in the request, leaving them untouched when they are absent.

The list endpoint SHALL accept the shared locale resolution (explicit `locale` parameter > `Accept-Language` first tag > zh) and project supply annotations per request locale: registry-sourced skills via `metadata.annotations`, file skills via the repo annotation source's `skills` key. An unannotated skill's entry SHALL remain byte-identical to the pre-change payload, and annotation projection MUST NOT perform any source writes.

#### Scenario: list skills via API

- **WHEN** client sends GET `/api/extensions/skills`
- **THEN** the server SHALL return a list of all skills with their name, description, source (built-in/custom/bundled), enabled state, origin, and locked flag
- **AND** a multi-file skill's entry SHALL additionally expose its auxiliary file paths and external provenance

#### Scenario: add custom skill via API

- **WHEN** client sends POST `/api/extensions/skills` with skill definition (name, description, body)
- **THEN** the server SHALL persist the skill (with `origin: "user"`), register it with the agent, and return success

#### Scenario: add custom skill from a package via API

- **WHEN** client sends POST `/api/extensions/skills` with an uploaded package (zip)
- **THEN** the server SHALL parse it under the package contract, persist the skill with its body, auxiliary file set, and captured frontmatter (with the platform's name and description), materialize the directory tree, and return the inventory

#### Scenario: package violating the contract is refused whole

- **WHEN** the uploaded package contains a path with `..` segments or exceeds an aggregate bound
- **THEN** the server SHALL return a 4xx naming the violating file or bound, and no skill row or materialized file is created

#### Scenario: remove custom skill via API

- **WHEN** client sends DELETE `/api/extensions/skills/:name`
- **THEN** the server SHALL unregister the skill, remove its definition, and return success
- **AND** built-in skills SHALL NOT be removable (return 400)
- **AND** locked bundled skills SHALL NOT be removable (return 400)

#### Scenario: enable/disable skill via API

- **WHEN** client sends PATCH `/api/extensions/skills/:name` with `{ "enabled": false }`
- **THEN** the server SHALL unregister the skill from the agent, mark it disabled, and return success
- **WHEN** client sends PATCH `/api/extensions/skills/:name` with `{ "enabled": true }`
- **THEN** the server SHALL register the skill with the agent, mark it enabled, and return success
- **WHEN** the named skill is locked
- **THEN** enable/disable requests SHALL return 400 and leave the entry untouched

#### Scenario: legacy single-file records are unchanged

- **WHEN** the server starts against a database created before auxiliary files existed
- **THEN** every existing skill lists with no auxiliary files and no external provenance, and all prior behaviors (list/add/remove/enable/disable) work unchanged

#### Scenario: annotated skill lists localized under its locale

- **WHEN** client sends GET `/api/extensions/skills?locale=zh` for a skill carrying a zh annotation
- **THEN** the entry carries the projected annotation (localized name and summary) alongside the unchanged slug and description
- **AND** the same request without the annotation present returns the entry exactly as before this change

#### Scenario: unannotated skill is byte-identical across locales

- **WHEN** client requests the list with `locale=zh` and `locale=en` for a skill with no annotation
- **THEN** both responses render the raw upstream text, identical to each other and to the pre-change payload
