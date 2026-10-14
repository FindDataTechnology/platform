## Purpose

Defines how agents create and manage scheduled tasks themselves through MCP tools available to every persona preset, and how those operations appear to the user in the conversation.

## Requirements

### Requirement: Scheduling tools are available to all presets
Every agent preset SHALL have access to scheduling tools — create, list, pause, and delete — exposed through the cell's local MCP configuration. The tools SHALL operate only on the jobs of the cell they run in.

#### Scenario: Tool visible to an agent
- **WHEN** an agent lists its available tools
- **THEN** the four scheduling tools are present regardless of the active preset

### Requirement: Agent-created jobs bind to the current preset and a dedicated session
A job created via the agent tool SHALL be bound to the preset the agent is running under and to a dedicated session for the job, following the engine's binding semantics. The tool SHALL return a confirmation payload carrying the job identifier, a human-readable schedule, the timezone applied, and the target session title.

#### Scenario: Agent schedules a recurring report
- **WHEN** the user says "每天早上九点给我一份新闻汇总" and the agent calls the create tool with cron `0 9 * * *`, the prompt, and the client-provided timezone
- **THEN** a job is created bound to the current preset with a dedicated session
- **AND** the tool result describes the schedule in human-readable form

#### Scenario: Missing timezone defaults safely
- **WHEN** the create tool is called without a timezone
- **THEN** the job SHALL use the cell's local timezone and the tool result SHALL state which timezone was applied

### Requirement: Invalid schedules return structured errors
When the create tool receives an invalid cron expression or a past one-shot time, it SHALL return a structured error the agent can act on, and no job SHALL be created.

#### Scenario: Bad cron expression
- **WHEN** the create tool is called with cron `99 * * *`
- **THEN** the tool returns a validation error naming the expression
- **AND** no job is created

### Requirement: Job cards render in the conversation
A scheduling tool invocation SHALL render in the conversation as a job card — not raw tool output — showing the schedule (human-readable, with timezone), prompt summary, target agent, and current status. The card SHALL expose pause/resume and delete affordances whose effects reconcile with the job list.

#### Scenario: Card on creation
- **WHEN** the agent creates a job during a conversation
- **THEN** the tool invocation renders as a job card with schedule, timezone, agent, and status

#### Scenario: Pause from the card
- **WHEN** the user taps pause on a job card
- **THEN** the card reflects paused state and the job stops firing

### Requirement: List, pause, and delete through tools
The list tool SHALL return the caller-visible jobs with schedule, status, and last result. Pause and delete SHALL accept a job identifier and report success or a not-found error. The tools SHALL NOT bypass the engine's queueing or binding semantics.

#### Scenario: Agent lists jobs
- **WHEN** the agent calls the list tool
- **THEN** all jobs in the cell are returned with id, schedule, timezone, status, and last outcome
