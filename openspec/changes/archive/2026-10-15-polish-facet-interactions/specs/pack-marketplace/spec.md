## ADDED Requirements

### Requirement: The pack detail dialog carries an always-visible action bar

The pack detail dialog SHALL render its primary actions in a bar fixed to the dialog's bottom edge — always visible regardless of the content scroll position — carrying the subscribe-and-install primary button and a visible close affordance. The former in-content action placement (the subscribe button at the end of the scrolling flow) SHALL be replaced by this bar. The bar's optional "go to my packs" affordance is host-selected: hosts pass it only where an installed-packs management surface exists (壹座); hosts without one (the facet shell) omit it. An explicit close control SHALL be present in the bar in addition to the existing overlay/Escape dismissal.

#### Scenario: the bar is visible without scrolling

- **WHEN** a visitor opens a pack whose detail content exceeds the dialog's scroll height
- **THEN** the action bar with the subscribe button and the close control is visible immediately, without scrolling

#### Scenario: the close control dismisses the dialog

- **WHEN** the visitor activates the bar's close control
- **THEN** the dialog closes exactly as the overlay or Escape dismissal does

#### Scenario: the facet dialog carries no goto-mine affordance

- **WHEN** the facet shell opens the pack detail dialog
- **THEN** the action bar shows the subscribe button and the close control and no "go to my packs" button

### Requirement: Anonymous subscribe attempts get a login guidance bar

When the host reports a signed-out viewer, activating the subscribe-and-install button SHALL NOT emit a raw error: the action bar SHALL surface an inline guidance row — a localized line stating that subscribing and installing require signing in, plus a sign-in action that navigates to the host's login entry (the facet shell: `/auth/login` with a same-origin return path back to the packs market, per the service's existing safe-return handling). Hosts that do not wire the signed-out signal keep the existing authenticated-error fallback unchanged (壹座 users always hold a session; that path is an edge state there, and its error text SHALL be localized rather than raw English).

#### Scenario: anonymous click surfaces the guidance row

- **WHEN** a signed-out visitor activates the subscribe-and-install button on the facet shell
- **THEN** the action bar shows the localized guidance row with a sign-in action, and no raw English error text renders

#### Scenario: sign-in returns to the packs market

- **WHEN** the visitor follows the guidance row's sign-in action and completes login
- **THEN** they land back on the packs market view (`#/packs`)

#### Scenario: hosts without the signal keep their fallback

- **WHEN** the dialog renders on a host that does not pass the signed-out signal and a subscribe call fails with an authentication error
- **THEN** the dialog shows a localized authentication guidance message in its error surface, unchanged in behavior otherwise

### Requirement: The deploy section explains itself in plain language

The pack detail dialog's deploy-as-a-service section SHALL open with a plain-language summary stating what deploying yields (the pack's agents go live as a conversation service: a shareable public chat page, per-round metering, deployer revenue share), and each of its subsections SHALL carry a one-line plain-language subtitle — the metering-key area (whose quota pays for visitor rounds), the rhythm area (whether the platform wakes the agent to act on its own schedule; no entries means it only answers when addressed). The deploy button's outcome expectation (deploying produces a shareable conversation page) SHALL be stated at the button. These explanations are presentation-level: the section's data behavior, permissions, and deploy semantics are exactly as before (openspec: pack-marketplace, deploy requirements; the section stays fully previewable to signed-out visitors).

#### Scenario: the section summary names the outcome

- **WHEN** the deploy section renders
- **THEN** it opens with the plain-language summary of what deploying yields before any control

#### Scenario: subsections carry their subtitles

- **WHEN** the deploy section renders with its metering-key and rhythm areas
- **THEN** each area carries its one-line plain-language subtitle

#### Scenario: the deploy button states its result

- **WHEN** the deploy section renders its deploy button
- **THEN** the expected outcome (a shareable conversation page) is stated adjacent to the button
