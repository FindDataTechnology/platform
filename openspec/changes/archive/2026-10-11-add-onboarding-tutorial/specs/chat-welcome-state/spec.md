## MODIFIED Requirements

### Requirement: Welcome state renders when no turns
When the chat page has zero turns (no in-flight conversation, no loaded history), the page SHALL render a **Welcome state** instead of an empty log. The welcome state SHALL contain: a greeting line (i18n: `chat.welcome.greeting`), 4 suggested prompt cards (i18n: `chat.welcome.suggestedPrompts`), a "Recent chats" list (the last 5 sessions from the sidebar store), and a subtle footer showing the current model and agent with a link to the Models page. The suggested prompt cards SHALL follow the currently selected expert: when the selected agent carries a pack id that has prompt content in the client content module, the cards SHALL present that pack's four prompts; when the selected agent is a custom preset or a focused role whose pack id has no prompt content, the cards SHALL present the focused-mode generic set; otherwise the cards SHALL present the default general set.

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
