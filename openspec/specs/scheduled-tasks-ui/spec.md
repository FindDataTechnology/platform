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

#### Scenario: Create a daily task
- **WHEN** the user picks "daily at 09:00", selects an agent, and enters a prompt
- **THEN** a recurring job is created with the client's timezone attached
- **AND** the job appears in the list with its next run time

#### Scenario: Custom cron expression
- **WHEN** the user enters a custom cron expression
- **THEN** invalid expressions SHALL be rejected with a visible error before submission

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
