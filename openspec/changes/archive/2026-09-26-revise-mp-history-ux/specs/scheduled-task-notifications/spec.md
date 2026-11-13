## MODIFIED Requirements

### Requirement: Entry-point surfacing
The miniprogram SHALL surface unread scheduled output at its navigation entry points (session history entry), and the web app at its session list, so a returning user can discover task output without opening the scheduled-task page first. On the miniprogram, the scheduled-task entry is the 「定时任务」 collapsed group in the history page, and the unread indication SHALL appear on that group's header (in addition to the per-session unread dot on the chat header's history entry) until the session is viewed.

#### Scenario: Returning user sees the badge
- **WHEN** the user opens the miniprogram and a task session has unseen output
- **THEN** the history entry point shows an unread indication until the session is viewed

#### Scenario: The task group carries the badge

- **WHEN** the user opens the history page and a task session has unseen output
- **THEN** the 「定时任务」 group header shows an unread indication, which clears once the session is viewed
