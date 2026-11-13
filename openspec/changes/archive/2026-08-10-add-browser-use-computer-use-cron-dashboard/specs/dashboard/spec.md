# dashboard Specification

## Purpose
Defines the system dashboard UI that provides real-time visibility into agent status, active tasks, scheduled jobs, and system activity history, accessible as a sidebar tab.

## ADDED Requirements

### Requirement: Dashboard is accessible as a sidebar tab
The chat UI SHALL include a "Dashboard" tab in the left sidebar alongside Chat, Chat History, Documents, and OpenConnector. Selecting the tab SHALL display the dashboard content in the main content area.

#### Scenario: Dashboard tab appears in sidebar
- **WHEN** the application loads
- **THEN** the sidebar SHALL include a "Dashboard" tab option
- **AND** clicking the tab SHALL show the dashboard content

#### Scenario: Dashboard maintains state on tab switch
- **WHEN** the user switches from Dashboard to another tab and back
- **THEN** the dashboard state (scroll position, expanded sections) SHALL be preserved

### Requirement: Dashboard shows agent status card
The dashboard SHALL display an agent status card showing the current agent state (idle/streaming/error), currently selected model, and uptime.

#### Scenario: Status shows idle
- **WHEN** no agent turn is in progress
- **THEN** the status card SHALL show "Idle" with a green indicator

#### Scenario: Status shows streaming
- **WHEN** the agent is actively streaming a response
- **THEN** the status card SHALL show "Streaming" with an animated indicator
- **AND** SHALL show the elapsed time of the current turn

### Requirement: Dashboard shows active tasks list
The dashboard SHALL display a list of currently active tasks including in-progress tool calls, document indexing jobs, and pending MCP operations.

#### Scenario: Active tool calls displayed
- **WHEN** the agent is executing one or more tools
- **THEN** each active tool SHALL appear in the active tasks list
- **AND** SHALL show the tool name, start time, and status

#### Scenario: Task removed on completion
- **WHEN** a tool completes execution
- **THEN** it SHALL be removed from the active tasks list
- **AND** SHALL appear in the recent activity log

### Requirement: Dashboard shows scheduled jobs table
The dashboard SHALL display a table of all scheduled cron jobs with their ID, schedule, next run time, last run time, and status (active/paused).

#### Scenario: Jobs table updates in real-time
- **WHEN** a `cron_status` event is received
- **THEN** the jobs table SHALL update to reflect the current state of all jobs

#### Scenario: Job controls available in dashboard
- **WHEN** viewing a job in the table
- **THEN** the user SHALL be able to pause/resume the job via a button
- **AND** SHALL be able to delete the job via a button
- **AND** SHALL be able to run the job immediately via a "Run Now" button

### Requirement: Dashboard shows recent activity log
The dashboard SHALL display a chronological log of recent agent activity including turns started, tools executed, jobs fired, and errors, showing the most recent 50 entries.

#### Scenario: Activity log updates in real-time
- **WHEN** any agent or cron event occurs
- **THEN** a new entry SHALL be added to the top of the activity log
- **AND** entries older than the 50 most recent SHALL be pruned

#### Scenario: Activity entries include type and timestamp
- **WHEN** an entry appears in the activity log
- **THEN** it SHALL show the event type (turn, tool, cron, error)
- **AND** SHALL show a human-readable timestamp
- **AND** SHALL show a brief description of the event

### Requirement: Dashboard receives aggregate update events
The server SHALL broadcast `dashboard_update` events containing a snapshot of the current dashboard state (agent status, active tasks, job summary, activity count) at most once every 2 seconds during activity.

#### Scenario: Dashboard updates throttled
- **WHEN** multiple events occur in rapid succession
- **THEN** `dashboard_update` events SHALL be throttled to at most one every 2 seconds
- **AND** the final state SHALL be accurate

#### Scenario: Initial state sent on connection
- **WHEN** a new client connects
- **THEN** the server SHALL send an initial `dashboard_update` event with the current state

### Requirement: Dashboard supports adding new cron jobs
The dashboard SHALL include a form to add new cron jobs with fields for prompt text, cron schedule, and optional one-shot datetime.

#### Scenario: Add recurring job via dashboard
- **WHEN** user fills the form with prompt and cron schedule and submits
- **THEN** a new recurring job SHALL be created
- **AND** SHALL appear in the jobs table

#### Scenario: Add one-shot job via dashboard
- **WHEN** user selects "One-shot" and fills a datetime and prompt
- **THEN** a new one-shot job SHALL be created
- **AND** SHALL appear in the jobs table with the scheduled run time
