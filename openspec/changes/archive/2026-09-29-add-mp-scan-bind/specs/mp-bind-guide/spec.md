## Purpose

The mini program's illustrated binding tutorial: where to go on the web,
what to open, and what to scan — so a first-time user can bind their account
without any outside instruction.

## ADDED Requirements

### Requirement: The bind guide walks the four steps to a QR

The mini program SHALL provide a bind-guide page reachable from the login
page （查看图文教程）. It SHALL present the binding journey as four ordered
steps, each with a schematic drawn from app styles (no external images):
open the platform site in a desktop browser; sign in; open ⚙ Settings and
select the WeChat App section; return to the phone and tap 扫码绑定 to scan
the QR shown on the web. Step one SHALL display the site address as text
with a copy affordance. The address SHALL be derived from the server the
client is currently connected to (the account origin — never the demo
origin), so development builds point at the development server. The page
SHALL end with a direct action to start the scan （立即扫码绑定） that opens
the same scanner the login page's primary button uses.

#### Scenario: the guide shows the four steps with the real origin

- **WHEN** the user opens the bind guide while connected to an account origin
- **THEN** four ordered steps are shown, each with a schematic
- **AND** step one names that origin's URL with a copy affordance

#### Scenario: copying the URL

- **WHEN** the user taps the copy affordance on the URL row
- **THEN** the platform URL is on the clipboard and a confirmation is shown

#### Scenario: starting the scan from the guide

- **WHEN** the user taps 立即扫码绑定
- **THEN** the scanner opens with the same behavior as the login page's primary action
