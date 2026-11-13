# scheduled-tasks-ui Specification (delta)

## MODIFIED Requirements

### Requirement: Task creation form
The management page SHALL offer a creation form with: schedule entry (preset frequencies — e.g. daily at a time, weekly at a day and time — plus a custom cron expression, an every-N interval builder with unit enum, and a relative one-shot input「N 分钟后/N 小时后」with a live preview of the resolved absolute occurrence), an agent picker populated from the available presets, a prompt field, a maximum-run-count field (optional) for recurring forms, and a timezone that defaults to the client's current timezone. One-shot scheduling at an absolute date-time SHALL also be available.

The form SHALL additionally offer two assist affordances that only PREFILL these fields, leaving every existing field and the creation behavior unchanged:

- **Templates**: a small set of localized one-click templates (e.g. daily data briefing, weekly report, hourly check) rendered above the form and in the page's empty state; activating one fills the name, prompt, and schedule fields with the template's values for further editing.
- **Natural-language schedule**: a single-line input accepting plain phrasing of a schedule (zh and en common patterns — daily/weekdays/a weekday at a time, every N minutes, hourly at a minute, and relative delays). While the input parses, the form SHALL show a live preview of the resulting schedule and a human-readable summary; activating apply SHALL fill the schedule fields from the parse. Input that does not parse SHALL show a hint directing the user to the manual controls below, and SHALL NOT fill any field.

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
- **THEN** a live preview SHALL show the equivalent schedule (`0 8 * * 1`) and a human-readable summary
- **AND** activating apply SHALL set the schedule fields accordingly

#### Scenario: Unparseable input falls back to manual controls
- **WHEN** the natural-language input does not match any supported pattern
- **THEN** a hint SHALL point to the manual schedule controls
- **AND** no schedule field SHALL change

#### Scenario: Relative one-shot previews its landing time
- **WHEN** the user types「30 分钟后」in the relative input
- **THEN** the form previews the resolved absolute occurrence computed from the client's clock as a display approximation, and creation submits the delay (not the wall time) for the server to anchor

#### Scenario: Interval builder expresses cron-impossible steps
- **WHEN** the user builds every 40 days
- **THEN** the job is created on the interval form and the list renders a localized every-40-days phrase

#### Scenario: Max runs caps a recurring job
- **WHEN** the user sets a maximum run count of 3 on a daily job
- **THEN** the list shows progress 已跑 x/3 and the task reports completed after the third execution

### Requirement: Job actions
Each task entry SHALL offer pause, resume, delete, run-now, and **edit** actions for schedule-triggered tasks, and a re-run action for executions that ended in `failed` or `interrupted`, with immediate feedback, reflecting optimistic state that reconciles with the broadcast task status. Edit reopens the form prefilled with the job's current name, prompt, schedule, and max-runs; submitting an edit preserves the job's identity, history, and paused state.

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

#### Scenario: Edit reschedules in place
- **WHEN** the user edits a daily 09:00 job to weekdays 10:00 and saves
- **THEN** the same task keeps its history and unread state, and the list shows the new schedule with a fresh next-run time

## ADDED Requirements

### Requirement: Run history expands per task
Each task entry SHALL offer an expandable run history listing past executions with occurrence time, outcome (done/failed/interrupted/missed 补跑标记), duration, and token usage when the record carries them, sourced from the task's existing history entries without a new backend enumeration. The most recent execution SHALL remain visible inline as today.

#### Scenario: History shows a downtime catchup
- **WHEN** the user expands a task whose history contains a missed/catch-up entry
- **THEN** that entry is labeled as missed with its catch-up run attached, alongside normal runs

#### Scenario: History does not block the list
- **WHEN** a task's history fails to load
- **THEN** the inline list and its latest-run badge render unaffected, with the expansion showing a retryable empty state
