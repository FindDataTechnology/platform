## Purpose

A floating in-conversation outline that lists every user turn and jumps the transcript to the selected one, so long conversations are navigable without manual scrolling. Applies to both the web chat UI and the mini-program client.

## ADDED Requirements

### Requirement: Outline lists user turns when the conversation is long enough
The chat UI SHALL render a conversation outline listing the session's user turns, in order, only when the conversation contains at least 3 user turns. Each entry SHALL show the first line of the user prompt, truncated, so entries stay one visual line.

#### Scenario: Short conversation shows no outline
- **WHEN** the transcript contains 2 user turns
- **THEN** no outline or edge control SHALL be rendered

#### Scenario: Long conversation shows the outline control
- **WHEN** the transcript contains 3 or more user turns
- **THEN** the outline SHALL be available on the right edge of the transcript area

#### Scenario: Entries mirror user prompts
- **WHEN** the outline is expanded and the user has asked "nihao", "你可以帮我做什么", and a multi-line report request
- **THEN** the outline SHALL show three entries in conversation order, each displaying the first line of that prompt, truncated to one line

### Requirement: Collapsed-by-default edge control with platform-native expansion
The outline SHALL default to a collapsed edge control anchored to the right edge of the transcript area. On the web, hovering the edge control or the expanded card SHALL keep the outline expanded, and leaving both SHALL collapse it. On the mini-program, tapping the edge control SHALL toggle between collapsed and expanded. The outline SHALL provide a visible collapse affordance (the "—" control) in the expanded state on both surfaces.

#### Scenario: Web hover expands, leave collapses
- **WHEN** the web user hovers over the collapsed edge control
- **THEN** the expanded card SHALL appear; and **WHEN** the pointer leaves both the card and the edge control
- **THEN** the card SHALL collapse back to the edge control

#### Scenario: Mini-program tap toggles
- **WHEN** the mini-program user taps the collapsed edge control
- **THEN** the expanded card SHALL appear, and tapping the card's collapse affordance SHALL return it to the edge control

#### Scenario: New session starts collapsed
- **WHEN** a session is created or switched and its transcript reaches the outline threshold
- **THEN** the outline SHALL start in the collapsed state

### Requirement: Web entry hover reveals the full prompt
On the web, hovering an outline entry SHALL reveal the entry's full user prompt text (detail view) without navigating; the un-hovered entries SHALL remain in truncated form.

#### Scenario: Hover shows full prompt
- **WHEN** the web user hovers an entry whose prompt was truncated
- **THEN** the full prompt text SHALL become visible for that entry while hovered, without scrolling the transcript

### Requirement: Activating an entry jumps to the turn and releases auto-scroll
Activating an outline entry (click on web, tap on mini-program) SHALL smoothly scroll the transcript so the corresponding turn is brought into view and briefly highlighted, and SHALL disable stick-to-bottom auto-scroll until the user returns to the bottom.

#### Scenario: Jump to an earlier turn
- **WHEN** the user activates the outline entry for the first user turn while the transcript is at the bottom
- **THEN** the transcript SHALL scroll that turn into view with a brief highlight, and subsequent streaming output SHALL NOT scroll the transcript away from that position

#### Scenario: Jump during active streaming
- **WHEN** an assistant turn is streaming and the user activates an outline entry
- **THEN** the jump SHALL take effect and incoming deltas SHALL NOT pull the view back to the bottom

#### Scenario: Returning to bottom restores auto-scroll
- **WHEN** the user has jumped via the outline and then scrolls back to the bottom of the transcript
- **THEN** stick-to-bottom auto-scroll SHALL resume
