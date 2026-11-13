## MODIFIED Requirements

### Requirement: The empty-session welcome offers suggested prompts that prefill the draft

When the session has no turns, the chat page SHALL present a welcome that
showcases the product and offers quick-start paths, in this order: a
positioning line, an agent-card grid for every chat-mode agent in the current
roster (each card showing the agent's name and description, tapping it SHALL
switch to that agent without leaving the page), a general-chat quick start,
the suggested-prompt cards, and a recent-sessions strip listing the most
recent sessions from the store's session list (tapping one SHALL load it).
When the roster contains no agents beyond the built-in one, the welcome SHALL
fall back to a prompts-and-recent layout without the card grid. The welcome
SHALL also offer a link to the sessions (history) page.

For a bound (signed-in or demo) user, tapping a suggested-prompt card SHALL
prefill the draft with the prompt text; it SHALL NOT send. For an unbound
user on a non-demo deployment, tapping a suggested-prompt card SHALL enter
the demo sandbox directly, carrying that prompt into the demo draft, and
SHALL NOT send.

#### Scenario: the showcase renders from the live roster

- **WHEN** the session has no turns and the roster holds the pack agents
- **THEN** the welcome shows a positioning line, one card per chat agent (name + description), a general-chat start, the suggested prompts, and a recent-sessions strip

#### Scenario: tapping a suggested prompt prefills without sending

- **WHEN** a bound user taps a suggested-prompt card on the welcome
- **THEN** the composer draft contains that prompt text and no prompt message is sent

#### Scenario: an unbound user's prompt tap starts the demo with context

- **WHEN** an unbound user on a non-demo deployment taps a suggested-prompt card
- **THEN** the client enters the demo sandbox and the demo draft is prefilled with that prompt — no prompt is sent from the account deployment

#### Scenario: roster-empty fallback

- **WHEN** the deployment exposes only the built-in agent
- **THEN** the welcome omits the card grid and still offers the prompts and the recent-sessions strip

### Requirement: The chat page header follows a three-zone layout

The chat page header SHALL present three affordances: a history entry that
opens the sessions page, the combined agent·model entry (per the selection
requirement), and a new-session action. The collapsed combined entry SHALL
show the active agent's name only; the active model SHALL be visible inside
the selection panel rather than in the collapsed label. The header SHALL NOT
contain the server-address setting; that setting SHALL be reachable from the
sessions (history) page.

#### Scenario: header renders the three zones

- **WHEN** the chat page is mounted
- **THEN** the header shows a history entry, one combined agent·model entry labeled with the active agent's name, and a new-session action, and no server-setting control

#### Scenario: the model is chosen from the panel

- **WHEN** the user opens the combined entry
- **THEN** the panel shows the active model alongside the agent and preset choices, and picking a model updates it without changing the collapsed label's agent name

#### Scenario: server address is set from the history page

- **WHEN** the user opens the sessions page and uses the server-settings entry there
- **THEN** the address can be edited and saved, and saving triggers a reconnect — the same behavior the chat-header entry had

## ADDED Requirements

### Requirement: Status and sign-in affordances occupy one quiet area

The chat page SHALL NOT stack multiple full-width banners. The unbound state
(loading required on a non-demo deployment) SHALL be presented inside the
welcome as its primary call-to-action — enter-demo first, sign-in secondary —
instead of a standalone banner. While on the demo origin, a single
lightweight notice line SHALL identify the demo environment and offer the
exit. Connection trouble (connecting / disconnected) SHALL render as a slim
top indicator with a tap-to-retry affordance, not a full banner row; the
indicator SHALL disappear when connected. These affordances SHALL preserve
the sign-in contract: nothing navigates to the login page without a user
tap, and no authorization popup may ever appear.

#### Scenario: an unbound first-open shows the showcase with inline CTAs

- **WHEN** an unbound user opens the app on a non-demo deployment
- **THEN** the first screen is the showcase welcome carrying the demo entry as the primary action and sign-in as the secondary action — no stacked banners, no forced navigation

#### Scenario: connection trouble is a slim indicator

- **WHEN** the connection is connecting or disconnected
- **THEN** a slim indicator with retry appears at the top and no full-width banner row is shown

#### Scenario: the demo notice is one line

- **WHEN** the client is on the demo origin
- **THEN** one notice line identifies the demo environment with an exit affordance, and no other status banners are stacked above the welcome
