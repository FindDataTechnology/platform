## Purpose

Defines how a user learns that a scheduled task produced output: the in-app unread semantics that always apply, and the best-effort WeChat subscribe-message envelope that layers on top of them.

## ADDED Requirements

### Requirement: Scheduled output marks its session unread
When a scheduled job produces output in its session and the user has not viewed that session since, the session SHALL be marked unread. Unread state SHALL be derived per client from the session's last-updated timestamp versus the user's last-viewed time for that session, requiring no server-side per-user read tracking.

#### Scenario: Unread after a scheduled run
- **WHEN** a job fires and its turn completes while the user is not viewing the job's session
- **THEN** that session is unread for that user

#### Scenario: Viewing clears unread
- **WHEN** the user opens the unread session
- **THEN** the unread state for that session clears on that client

#### Scenario: Unread survives app restarts
- **WHEN** the user closes and reopens the app without viewing the session
- **THEN** the session remains marked unread

### Requirement: Entry-point surfacing
The miniprogram SHALL surface unread scheduled output at its navigation entry points (session history entry), and the web app at its session list, so a returning user can discover task output without opening the scheduled-task page first.

#### Scenario: Returning user sees the badge
- **WHEN** the user opens the miniprogram and a task session has unseen output
- **THEN** the history entry point shows an unread indication until the session is viewed

### Requirement: WeChat subscribe-message envelope is best-effort
The system MAY deliver a WeChat subscribe message for a completed job when the user has an unused message consent for that template. When consent is absent or exhausted, delivery SHALL silently degrade to in-app unread only; job execution and history SHALL be unaffected. Consent SHALL be requested only from explicit user interaction (task creation flow or an in-app notice setting), never opportunistically.

#### Scenario: Consent available
- **WHEN** a job completes and the user holds an unused consent for the notification template
- **THEN** a subscribe message summarizing the job and linking to its session is sent

#### Scenario: Consent exhausted
- **WHEN** a job completes and no unused consent remains
- **THEN** no message is sent and no error surfaces to the user
- **AND** the session's unread state is unaffected

#### Scenario: Consent requested only on interaction
- **WHEN** the user creates a task in the miniprogram
- **THEN** the app MAY offer the notification-consent dialog as part of that flow
- **AND** the system SHALL NOT request consent outside explicit user interaction
