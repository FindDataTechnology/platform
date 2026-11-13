## ADDED Requirements

### Requirement: Server decomposition preserves the external contract
The backend SHALL remain launchable via `node server.js` with the same HTTP route surface (paths, methods, status codes), the same WebSocket message protocol, the same middleware ordering semantics (forward-auth gate before handlers, static + SPA fallback registered last), and the same boot/initialization ordering as the pre-decomposition monolith. Internal code organization into `server/` modules SHALL NOT introduce observable behavior changes.

#### Scenario: e2e suite passes unchanged after extraction
- **WHEN** the full offline e2e `fast` project runs against the decomposed server
- **THEN** all tests that passed pre-decomposition SHALL pass post-decomposition without modification to specs or the frontend

#### Scenario: entrypoint and middleware order are stable
- **WHEN** the server starts via `node server.js` (dev) or the supervisor/packaged launcher
- **THEN** static assets and SPA fallback SHALL remain served after all `/api` routes
- **AND** WebSocket upgrades SHALL pass through the same identity gate as HTTP requests when forward-auth is enabled

#### Scenario: boot initialization ordering is preserved
- **WHEN** the server initializes (db, documents store, dsh agent, legacy migrations, catalog, cron)
- **THEN** initialization SHALL occur in the same relative order as before decomposition, in particular documents-store init before legacy migrations run
