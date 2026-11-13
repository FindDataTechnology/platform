## MODIFIED Requirements

### Requirement: Selecting a preset switches the live session without a restart
The server SHALL apply a permission preset switch to the current dsh session
in place (no child restart, composer send stays enabled once the confirming
broadcast lands). The switch SHALL be rejected while a turn is streaming, and
an unknown preset name SHALL produce an error delivered only to the
requesting client.

The client SHALL require an explicit risk acknowledgement before requesting
the `danger-full-access` preset: selecting it SHALL open a localized
confirmation dialog naming the preset and its risk, with an acknowledgement
control that enables the confirm action; `set_permission` SHALL be sent only
from that confirmed action. Cancelling, dismissing, or Escape SHALL send
nothing and leave the effective preset unchanged. All other presets SHALL
apply immediately on selection as before. The client SHALL display
`danger-full-access` as `Full access` in the control and roster.

#### Scenario: user tightens the mode mid-session
- **WHEN** the user selects `read-only` while no turn is streaming
- **THEN** the switch applies to the live session and every connected client
  receives the new current preset

#### Scenario: switch during streaming is rejected
- **WHEN** the user selects a preset while a turn is streaming
- **THEN** the server rejects the request with an error to the requesting
  client and the effective preset is unchanged

#### Scenario: full access requires acknowledgement
- **WHEN** the user selects `danger-full-access` while no turn is streaming
- **THEN** the client SHALL open the confirmation dialog and SHALL NOT send
  `set_permission` yet
- **AND** the confirm action SHALL be disabled until the acknowledgement is
  checked
- **WHEN** the user then confirms
- **THEN** the client SHALL send `set_permission` for `danger-full-access`

#### Scenario: dismissing the confirmation changes nothing
- **WHEN** the confirmation dialog is open and the user cancels, presses
  Escape, or clicks outside
- **THEN** no `set_permission` SHALL be sent and the control SHALL continue
  showing the previously effective preset
