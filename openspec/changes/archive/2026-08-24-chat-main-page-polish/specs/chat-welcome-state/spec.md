# chat-welcome-state Specification

## Purpose
The chat page's empty state is the first thing a user sees when they open the app or start a new session. It guides the user toward the most useful first actions — suggested prompts, recent activity, and a clear sense of which model/agent is active.

## Requirements

### Requirement: Welcome state renders when no turns

## ADDED Requirements

### Requirement: Welcome state renders when no turns
When the chat page has zero turns (no in-flight conversation, no loaded history), the page SHALL render a **Welcome state** instead of an empty log. The welcome state SHALL contain: a greeting line (i18n: `chat.welcome.greeting`), 4 suggested prompt cards (i18n: `chat.welcome.suggestedPrompts`), a "Recent chats" list (the last 5 sessions from the sidebar store), and a subtle footer showing the current model and agent with a link to the Models page.

#### Scenario: empty chat shows welcome
- **WHEN** the user opens the app with no active conversation
- **THEN** the page SHALL render the Welcome state
- **AND** the greeting, 4 suggested prompt cards, and recent chats list SHALL be visible
- **AND** the message-log "no messages" placeholder SHALL NOT be rendered

#### Scenario: clicking a suggested prompt fills the composer
- **WHEN** the user clicks one of the 4 suggested prompt cards
- **THEN** the composer input SHALL be filled with the card's prompt text
- **AND** the composer SHALL receive focus

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
