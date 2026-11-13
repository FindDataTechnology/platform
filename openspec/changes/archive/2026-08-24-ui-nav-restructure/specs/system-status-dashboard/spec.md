# system-status-dashboard Specification

## Purpose
The System Status page (route `/dashboard`) is the read-only health view of the running platform. It surfaces which services are up, which LLM provider/model is active, document and MCP resource counts, and the live uptime. The page is reachable from the sidebar Settings menu and from the legacy `/dashboard` URL. The page is read-only — configuration happens on dedicated pages (Models, MCP, Skills, OpenConnector).

## Requirements

### Requirement: System Status page is reachable from the Settings menu

## ADDED Requirements

### Requirement: System Status page is reachable from the Settings menu
The page at `/dashboard` SHALL be titled "System Status" (i18n key `systemStatus.title`) and SHALL be reachable from the sidebar Settings menu. The page SHALL be read-only — no configuration actions are exposed here; each section is a summary with a "Manage" link to the relevant configuration page.

#### Scenario: System Status page renders
- **WHEN** the user navigates to `/dashboard` or selects System Status from the Settings menu
- **THEN** the page SHALL render with three sections: **Health** (per-service state), **Active Configuration** (current provider, model, agent, OpenConnector enabled/disabled), **Resources** (document count by status, MCP tool count, collection count, uptime)

### Requirement: Health section lists supervised services
The Health section SHALL list every supervised process (server-js, OpenConnector, LiteLLM, etc.) with a state indicator (healthy / disabled / unhealthy / starting) sourced from `GET /api/supervisor/status`. The state indicator SHALL be color-coded (green / grey / red / amber) consistent with the existing dashboard. Each row SHALL show service name and (when applicable) port. No actions SHALL be available — this is a read-only health summary.

#### Scenario: healthy services shown
- **WHEN** all supervised processes are healthy
- **THEN** the Health section SHALL list each service with a green dot and the localized "healthy" label

### Requirement: Active Configuration section shows current provider, model, and agent
The Active Configuration section SHALL display: current LLM provider name, current model id, current agent id (local/remote), and whether OpenConnector is enabled. Each item SHALL have a "Manage" link to the relevant page (Models page, Models page, Agents page, Settings → OpenConnector).

#### Scenario: shows active configuration
- **WHEN** the page renders
- **THEN** the Active Configuration section SHALL show the current model id, provider name, and agent id from the live state
- **AND** each row SHALL have a clickable link to the page that controls it

### Requirement: Resources section shows counts
The Resources section SHALL display: total document count, per-status document counts, collection count, and MCP tool count. Counts SHALL be sourced from `GET /api/supervisor/status` (non-secret fields only, same as today). A "Refresh" button SHALL re-fetch the status.

#### Scenario: refresh reloads status
- **WHEN** the user clicks the Refresh button
- **THEN** the page SHALL re-fetch `/api/supervisor/status`
- **AND** update all sections with the new values
- **AND** the button SHALL be disabled while the request is in flight
