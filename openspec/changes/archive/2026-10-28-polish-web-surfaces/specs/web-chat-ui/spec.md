## MODIFIED Requirements

### Requirement: Transcript rendering is windowed

The conversation view SHALL mount only the most recent N turns on session open, with an affordance to load earlier turns in batches. The store SHALL hold the **loaded window** of turns — initially the N most recent, as delivered by the server's first-frame window — and the load-earlier affordance SHALL fetch the preceding page from the server and prepend it, extending the loaded window. Features that read the turn list (outline navigation, export) SHALL keep operating without error over the loaded window, and MAY request all pages when they require the complete transcript. N SHALL be the same constant the server uses for its first-frame window.

#### Scenario: long session opens without mounting everything

- **WHEN** a session with several hundred turns is opened
- **THEN** only the most recent N turns mount, and the transcript is scrolled to the bottom
- **AND** an affordance to load earlier turns is presented at the top

#### Scenario: loading earlier turns prepends history

- **WHEN** the user activates the load-earlier affordance
- **THEN** the previous batch of turns is fetched from the server and mounts above the current window without losing scroll position

#### Scenario: the affordance disappears at the oldest turn

- **WHEN** the loaded window already includes the session's first turn
- **THEN** the load-earlier affordance SHALL NOT be presented
