## Purpose

Defines the web and miniprogram surfaces where users manage scheduled tasks: browsing job state, creating tasks with schedule, agent, and prompt, and acting on jobs (pause, resume, delete, run now).

## Requirements

### Requirement: Scheduled-task management page
Both the web app and the miniprogram SHALL provide a task management page (the 唯一任务中心) listing all tasks — not only scheduled ones — with their trigger kind, target persona, prompt, lifecycle state, schedule and timezone label and next run (schedule-triggered tasks), last execution timestamp, and last outcome. The list SHALL update live from the task/job event surface (`cron_*` events) without requiring a manual refresh.

#### Scenario: Browse jobs
- **WHEN** the user opens the task page
- **THEN** all tasks are listed with trigger kind, persona, prompt, lifecycle state, next run where a schedule applies, and last outcome

#### Scenario: Scheduled tasks render as the schedule-trigger category
- **WHEN** the page lists a mix of schedule-triggered and other tasks
- **THEN** each entry shows its trigger kind, and scheduled entries keep showing schedule, timezone, and next run

#### Scenario: Live update
- **WHEN** a task's state changes while the page is open
- **THEN** the affected row SHALL update without a manual refresh

### Requirement: Task creation form
The management page SHALL offer a creation form with: schedule entry (preset frequencies — e.g. daily at a time, weekly at a day and time — plus a custom cron expression), an agent picker populated from the available presets, a prompt field, and a timezone that defaults to the client's current timezone. One-shot scheduling at an absolute date-time SHALL also be available.

The form SHALL additionally offer two assist affordances that only PREFILL these fields, leaving every existing field and the creation behavior unchanged:

- **Templates**: a small set of localized one-click templates (e.g. daily data briefing, weekly report, hourly check) rendered above the form and in the page's empty state; activating one fills the name, prompt, and schedule fields with the template's values for further editing.
- **Natural-language schedule**: a single-line input accepting plain phrasing of a schedule (zh and en common patterns — daily/weekdays/a weekday at a time, every N minutes, hourly at a minute). While the input parses, the form SHALL show a live preview of the resulting cron expression and a human-readable summary; activating apply SHALL fill the schedule fields from the parse. Input that does not parse SHALL show a hint directing the user to the manual controls below, and SHALL NOT fill any field.

#### Scenario: Create a daily task
- **WHEN** the user picks "daily at 09:00", selects an agent, and enters a prompt
- **THEN** a recurring job is created with the client's timezone attached
- **AND** the job appears in the list with its next run time

#### Scenario: Custom cron expression
- **WHEN** the user enters a custom cron expression
- **THEN** invalid expressions SHALL be rejected with a visible error before submission

#### Scenario: Template prefills the form
- **WHEN** the user activates the weekly-report template
- **THEN** the form's name, prompt, and schedule fields SHALL be filled with the template's values and remain editable

#### Scenario: Natural-language schedule parses and applies
- **WHEN** the user types「每周一早上 8 点」in the natural-language input
- **THEN** a live preview SHALL show the equivalent cron (`0 8 * * 1`) and a human-readable summary
- **AND** activating apply SHALL set the schedule fields accordingly

#### Scenario: Unparseable input falls back to manual controls
- **WHEN** the natural-language input does not match any supported pattern
- **THEN** a hint SHALL point to the manual schedule controls
- **AND** no schedule field SHALL change

### Requirement: Job actions
Each task entry SHALL offer pause, resume, delete, and run-now actions for schedule-triggered tasks, and a re-run action for executions that ended in `failed` or `interrupted`, with immediate feedback, reflecting optimistic state that reconciles with the broadcast task status.

#### Scenario: Pause from the list
- **WHEN** the user pauses an enabled scheduled task
- **THEN** the entry shows paused state
- **AND** the task's schedule stops firing

#### Scenario: Delete confirmation
- **WHEN** the user deletes a task
- **THEN** the system asks for confirmation before removal

#### Scenario: Re-run a failed task
- **WHEN** the user taps re-run on a task whose last execution failed
- **THEN** the entry reflects a queued execution
- **AND** the reconciled broadcast state shows the fresh execution running

### Requirement: Task output is reachable from the list
Each job entry SHALL link to the job's dedicated session, so the user can read the output a scheduled task has produced.

#### Scenario: Open a task's output
- **WHEN** the user taps a job's output link
- **THEN** the app opens that job's session in the chat view

### Requirement: Schedule display is human-readable
The list and creation form SHALL render schedules in the active locale as human-readable text (e.g. "每天 09:00") alongside the raw cron expression when a custom expression is used, with the timezone shown explicitly.

#### Scenario: Localized schedule text
- **WHEN** the list renders a daily job while the locale is zh-CN
- **THEN** the schedule reads as a localized daily-time phrase and the timezone is visible

### Requirement: Unread indication on task output sessions
Session-list entries and task-list entries for a job whose session has new output the user has not yet viewed SHALL carry a visible unread indication. Rendering the badge is this capability's concern; what counts as unread is defined by `scheduled-task-notifications`.

#### Scenario: Badge after scheduled run
- **WHEN** a job fires and produces output while its session is not open
- **THEN** the session list shows an unread indication on that job's session
- **AND** the indication clears when the user opens the session
