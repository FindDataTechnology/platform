# chat-welcome-state Specification

## Purpose
The chat page's empty state — what a user sees before the first turn of a session: the greeting line, suggested prompt cards that follow the selected expert, the recent-session list, and (since intent-onboarding) the first-run questionnaire panel. It exists to get someone from "nothing typed yet" to a productive first prompt.
## Requirements

### Requirement: Welcome state renders when no turns

When the chat page has zero turns (no in-flight conversation, no loaded history), the page SHALL render a **Welcome state** instead of an empty log. The welcome state SHALL contain: a greeting line (i18n: `chat.welcome.greeting`), 4 suggested prompt cards (i18n: `chat.welcome.suggestedPrompts`), a "Recent chats" list (the last 5 sessions from the sidebar store), and a subtle footer showing the current model and agent with a link to the Models page. The suggested prompt cards SHALL follow the currently selected expert: when the selected agent carries a pack id that has prompt content in the client content module, the cards SHALL present that pack's four prompts; when the selected agent is a custom preset or a focused role whose pack id has no prompt content, the cards SHALL present the focused-mode generic set; otherwise the cards SHALL present the default general set.

Additionally, for a user whose intent profile is empty and not marked skipped, the welcome state SHALL present the onboarding questionnaire panel above the suggested prompt cards (per `intent-onboarding`); the panel's presence SHALL NOT alter the greeting, prompt-card, recent-chats, or footer behavior, and the composer SHALL remain usable.

#### Scenario: empty chat shows welcome

- **WHEN** the user opens the app with no active conversation
- **THEN** the page SHALL render the Welcome state
- **AND** the greeting, 4 suggested prompt cards, and recent chats list SHALL be visible
- **AND** the message-log "no messages" placeholder SHALL NOT be rendered

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

- **WHEN** the welcome state renders for a user with an empty, unskipped intent profile
- **THEN** the onboarding questionnaire panel SHALL appear above the suggested prompt cards
- **AND** the greeting, prompt cards, recent chats, and footer SHALL render as usual

#### Scenario: no questionnaire after answering or skipping

- **WHEN** the welcome state renders for a user whose profile is answered or marked skipped
- **THEN** no onboarding panel SHALL be present and the welcome state renders as before this change

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
