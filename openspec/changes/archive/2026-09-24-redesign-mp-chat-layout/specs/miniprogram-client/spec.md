# Delta Spec: miniprogram-client

## MODIFIED Requirements

### Requirement: Model and agent selection work and respect the streaming guard

The client SHALL offer model selection and chat-agent selection sourced from
the same `list_models` / `list_agents` protocol messages as the web client.
Selection SHALL be surfaced through a single combined entry in the chat
header (agent · model) that opens a bottom selection panel; the panel SHALL
list agents and models, apply a choice immediately on tap, and be dismissible
without change via the mask or a close affordance. In an empty session the
panel SHALL also offer preset selection (broken presets excluded); once the
session has turns the preset section SHALL NOT appear. A switch SHALL be
rejected while a turn is streaming, matching the web contract, and the
previously selected model/agent SHALL remain reported as current after a
rejected switch. The combined entry SHALL reflect the currently selected
agent and model.

#### Scenario: switching models while idle vs streaming

- **WHEN** the user opens the selection panel, switches models while no turn is streaming, and dismisses the panel
- **THEN** the selection applies, is reflected in the combined header entry, and is reported as current
- **WHEN** the user attempts a switch while a turn is streaming
- **THEN** the switch is rejected and the previous selection remains current

#### Scenario: dismissing the panel changes nothing

- **WHEN** the user opens the selection panel and taps the mask (or close) without choosing
- **THEN** the panel closes and the previously selected agent/model/preset remain current

#### Scenario: presets appear only in an empty session

- **WHEN** the session has zero turns and the user opens the selection panel
- **THEN** preset choices are listed alongside agents and models
- **WHEN** the session already has turns
- **THEN** the panel offers agents and models only

## ADDED Requirements

### Requirement: The chat page header follows a three-zone layout

The chat page header SHALL present three affordances: a history entry that
opens the sessions page, the combined agent·model entry (per the selection
requirement), and a new-session action. The header SHALL NOT contain the
server-address setting; that setting SHALL be reachable from the sessions
(history) page. The connection banner (connecting / disconnected / retry)
SHALL keep appearing above the header independently of this layout.

#### Scenario: header renders the three zones

- **WHEN** the chat page is mounted
- **THEN** the header shows a history entry, one combined agent·model entry, and a new-session action, and no server-setting control

#### Scenario: server address is set from the history page

- **WHEN** the user opens the sessions page and uses the server-settings entry there
- **THEN** the address can be edited and saved, and saving triggers a reconnect — the same behavior the chat-header entry had

### Requirement: The composer renders as a card with inline controls

The composer SHALL render as a single rounded card containing the text input,
any pending attachment chips, and a controls row — attach action on the left,
send/stop control on the right — inside the card. The send control SHALL do
nothing when the draft is empty and no attachment is attached, and while a
configuration switch is pending. While a turn streams, the send control SHALL
be replaced by a stop control whose activation locally finalizes the turn.
The composer's bottom padding SHALL account for the device safe-area inset so
the controls are never overlapped by the home indicator, and keyboard lift
SHALL keep the card visible above the keyboard.

#### Scenario: composer card holds input, chips, and controls together

- **WHEN** the user attaches a document and types a draft
- **THEN** the attachment chip and the text input are visible inside the same card as the attach and send controls

#### Scenario: send becomes stop while streaming

- **WHEN** a turn is streaming
- **THEN** the right-hand control is a stop control, and tapping it finalizes the turn locally and restores the send control

### Requirement: The empty-session welcome offers suggested prompts that prefill the draft

When the session has no turns, the chat page SHALL present a centered welcome
containing a greeting and four suggested-prompt cards. Tapping a card SHALL
prefill the draft with the prompt text; it SHALL NOT send. The welcome SHALL
also offer a link to the sessions (history) page.

#### Scenario: tapping a suggested prompt prefills without sending

- **WHEN** the welcome is showing and the user taps a suggested-prompt card
- **THEN** the composer draft contains that prompt text and no prompt message is sent

### Requirement: Assistant turns expose copy and regenerate actions

Every completed (non-streaming) assistant turn SHALL expose a copy action that
places the turn's text content — the concatenated plain text of its text
blocks, in order — on the clipboard and confirms with a toast. The most
recent assistant turn SHALL additionally expose a regenerate action when no
turn is streaming; activating it SHALL re-send the last user prompt as a new
appended turn, leaving prior history unmutated. Regenerate SHALL NOT appear
on a non-latest assistant turn or when no user turn precedes it.

#### Scenario: copy places the turn text on the clipboard

- **WHEN** the user taps the copy action of a completed assistant turn
- **THEN** the clipboard holds the turn's text-block content and a confirmation toast appears

#### Scenario: regenerate appends an honest new turn

- **WHEN** the user taps regenerate on the latest assistant turn while nothing is streaming
- **THEN** the last user prompt is re-sent as a new prompt and a new user+assistant turn pair is appended — the previous turns are unchanged
