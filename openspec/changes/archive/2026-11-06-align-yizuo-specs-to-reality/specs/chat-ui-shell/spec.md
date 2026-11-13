## MODIFIED Requirements

### Requirement: Backend code remains buildless

The Node backend (`server.js`, `dsh-bridge.js`, `documents.js`, `chat-history.js`, `collections.js`, `db.js`, and `electron/**`) SHALL remain plain ES modules with no transpilation step. The introduction of a bundler SHALL be scoped to `web/`.

#### Scenario: Backend has no transpilation
- **WHEN** a maintainer edits a backend module
- **THEN** the edit SHALL take effect on the next `npm start` with no build step
