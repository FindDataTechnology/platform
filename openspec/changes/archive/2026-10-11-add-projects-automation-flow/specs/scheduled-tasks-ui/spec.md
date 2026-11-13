## MODIFIED Requirements

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
