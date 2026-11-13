## MODIFIED Requirements

### Requirement: Backend API for managing skills at runtime
The server SHALL expose REST API endpoints to list, add, remove, enable, and disable skills without requiring a server restart. Each listed skill SHALL include its `origin` and `locked` flag. Locked bundled skills SHALL NOT be removable, disable-able, or editable via the API: such requests SHALL return 400. A skill record MAY additionally carry an auxiliary file set (a mapping of relative paths to text contents) and external-origin provenance metadata; a record without them behaves as a single-file skill exactly as before, and every existing record (pre-migration rows) SHALL remain in that single-file shape with unchanged behavior. The list endpoint SHALL expose each skill's auxiliary file inventory (paths only) and its external provenance when present, so clients can distinguish multi-file and externally-installed skills from locally authored ones.

#### Scenario: list skills via API
- **WHEN** client sends GET `/api/extensions/skills`
- **THEN** the server SHALL return a list of all skills with their name, description, source (built-in/custom/bundled), enabled state, origin, and locked flag
- **AND** a multi-file skill's entry SHALL additionally expose its auxiliary file paths and external provenance

#### Scenario: add custom skill via API
- **WHEN** client sends POST `/api/extensions/skills` with skill definition (name, description, body)
- **THEN** the server SHALL persist the skill (with `origin: "user"`), register it with the agent, and return success

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
