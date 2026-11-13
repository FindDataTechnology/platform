## MODIFIED Requirements

### Requirement: Status and sign-in affordances occupy one quiet area

The chat page SHALL NOT stack multiple full-width banners. The unbound state
(loading required on a non-demo deployment) SHALL be presented inside the
welcome as its primary call-to-action — enter-demo first, sign-in secondary —
instead of a standalone banner. While on the demo origin, a single
lightweight notice line SHALL identify the demo environment and offer the
bind call-to-action (and plain exit) per the `mp-demo-sandbox` capability.
Connection trouble (connecting / disconnected) SHALL render as a slim top
indicator with a tap-to-retry affordance, not a full banner row; the
indicator SHALL disappear when connected. These affordances SHALL preserve
the sign-in contract: nothing navigates to the login page without a user
tap, and no authorization popup may ever appear.

While disconnected, the indicator block SHALL be self-diagnosing: it SHALL
show the server address the app is currently using, with an edit affordance
that opens the login page with its server field expanded (the field is a
real input on every base library — never an editable modal); changing the
address SHALL persist it and re-boot the runtime against the new origin. It
SHALL additionally show the transport's own failure text for the last
attempt (e.g. `request:fail url not in domain list`, `connectSocket:fail …`,
or the server's error body) verbatim, so a real-device user can tell a
domain-list block from a rejected login without guesswork. The reason text
SHALL clear on a successful connection.

#### Scenario: an unbound first-open shows the showcase with inline CTAs

- **WHEN** an unbound user opens the app on a non-demo deployment
- **THEN** the first screen is the showcase welcome carrying the demo entry as the primary action and sign-in as the secondary action — no stacked banners, no forced navigation

#### Scenario: connection trouble is a slim indicator

- **WHEN** the connection is connecting or disconnected
- **THEN** a slim indicator with retry appears at the top, naming the server address in use with an edit affordance
- **AND** when the last attempt failed, the transport's own failure text is shown beneath it
- **AND** no full-width banner row is shown

#### Scenario: editing the server address from the indicator

- **WHEN** the user taps the indicator's edit affordance while disconnected
- **THEN** the login page opens with the server field expanded and pre-filled with the current address
- **AND** saving a changed address re-boots against the new origin

#### Scenario: the demo notice is one line

- **WHEN** the client is on the demo origin
- **THEN** one notice line identifies the demo environment with the bind and exit affordances, and no other status banners are stacked above the welcome
