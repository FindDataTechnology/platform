# chat-welcome-state Specification

## Purpose
The chat page's empty state — what a user sees before the first turn of a session: the greeting line, suggested prompt cards that follow the selected expert, the recent-session list, and (since intent-onboarding) the first-run questionnaire panel. It exists to get someone from "nothing typed yet" to a productive first prompt.

## Requirements

### Requirement: Welcome state renders when no turns

When the chat page has zero turns (no in-flight conversation, no loaded history), the page SHALL render a **Welcome state** instead of an empty log. The welcome state SHALL contain: a greeting line (i18n: `chat.welcome.greeting`), 4 suggested prompt cards (i18n: `chat.welcome.suggestedPrompts`), a "Recent chats" list (the last 5 sessions from the sidebar store), and a subtle footer showing the current model and agent with a link to the Models page. The welcome state SHALL also host the first-run surfaces governed by the server-reported stage (per `first-run-onboarding`): the intent questionnaire / configuration confirmation at stages `new` / `role_answered` (per `intent-onboarding`), and the first-result guidance at stage `provisioned` (per `onboarding-guidance`). At most one foreground first-run surface SHALL be visible at a time. The **team-building door card** (per `team-building-first-run`) SHALL occupy its own slot **below** the suggested prompt cards rather than above them, SHALL NOT displace any of the 4 prompt cards, SHALL NOT alter the prompt cards' follow-the-expert behavior, and SHALL NOT be visible while a configuration confirmation or the first-result guidance is visible.

#### Scenario: empty chat shows welcome

- **WHEN** the user opens the app with no active conversation
- **THEN** the page SHALL render the Welcome state
- **AND** the greeting, 4 suggested prompt cards, and recent chats list SHALL be visible
- **AND** the message-log "no messages" placeholder SHALL NOT be rendered

#### Scenario: door card does not consume a prompt slot

- **WHEN** the welcome state renders with the door card present
- **THEN** the door card SHALL render below the 4 suggested prompt cards
- **AND** exactly 4 suggested prompt cards SHALL still render
- **AND** each of them SHALL still prefill the composer per its own contract

#### Scenario: clicking a suggested prompt fills the composer

- **WHEN** the user clicks one of the 4 suggested prompt cards
- **THEN** the composer input SHALL be filled with the card's prompt text
- **AND** the composer SHALL receive focus

#### Scenario: prompts follow a pack expert

- **WHEN** the user selects an agent whose pack id has prompt content in the client content module
- **THEN** the welcome state SHALL render that pack's four prompt cards in place of the default set

#### Scenario: prompts fall back for focused roles without pack content

- **WHEN** the user selects a custom preset or a focused role whose pack id has no prompt content
- **THEN** the welcome state SHALL render the focused-mode generic four-card set

#### Scenario: questionnaire panel on first entry only

- **WHEN** the welcome state renders for a user whose stage is `new` and the deployment has a recipe-ready role
- **THEN** the questionnaire panel SHALL appear and no other foreground first-run surface SHALL be visible
- **AND** the greeting, prompt cards, recent chats, and footer SHALL render as usual

#### Scenario: no questionnaire after answering or skipping

- **WHEN** the welcome state renders for a user whose stage is `provisioned` or `done`
- **THEN** no questionnaire panel SHALL be present
- **AND** at stage `role_answered` (answers recorded, not yet activated) the panel re-opens pre-filled per `intent-onboarding`, since the confirmation list is not persisted

#### Scenario: one foreground surface at a time

- **WHEN** the welcome state renders at any stage
- **THEN** at most one of {questionnaire, configuration confirmation, first-result guidance} SHALL be visible

### Requirement: Recent chats shows last 5 sessions
The Welcome state's "Recent chats" list SHALL show the most-recent 5 sessions from the store (sorted by `updatedAt` desc). Each row SHALL show the session title (or "Untitled") and a relative timestamp ("3h ago", "yesterday"). Clicking a row SHALL switch to that session (load it via the existing session-switch WS path). If there are no sessions, the list SHALL be hidden (and a "no recent chats" hint is not shown — the welcome still works).

#### Scenario: recent chats populated
- **WHEN** the Welcome state renders and the session store has entries
- **THEN** the list SHALL show up to 5 sessions ordered by updatedAt descending
- **AND** clicking a row SHALL switch the active session

### Requirement: Greeting is i18n-aware
The greeting text SHALL be resolved from the active locale. Changing the language SHALL update the greeting live (no reload).

#### Scenario: greeting follows locale
- **WHEN** the user changes the language from en to zh-CN
- **THEN** the greeting SHALL update to the Simplified-Chinese value without a page reload
