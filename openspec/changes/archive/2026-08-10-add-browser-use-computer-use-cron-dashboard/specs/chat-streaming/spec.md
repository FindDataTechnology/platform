# chat-streaming Specification Delta

## ADDED Requirements

### Requirement: Server broadcasts dashboard and cron events
The server SHALL broadcast `dashboard_update`, `cron_status`, `cron_fired`, and `cron_completed` WebSocket events to all connected clients.

#### Scenario: Cron events broadcast
- **WHEN** a cron job is added, removed, paused, resumed, or executed
- **THEN** the corresponding cron event SHALL be broadcast to all clients

#### Scenario: Dashboard update broadcast
- **WHEN** the dashboard state changes and throttling allows
- **THEN** a `dashboard_update` event SHALL be broadcast to all clients
