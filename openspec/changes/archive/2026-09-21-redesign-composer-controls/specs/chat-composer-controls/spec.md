## MODIFIED Requirements

### Requirement: Composer renders a control strip beneath the input
The chat composer SHALL render its controls in a single row beneath the textarea, split into two clusters. The left cluster SHALL contain, in order: a `+` menu button whose menu offers file attachment and the commands entry, and the permission control. The right cluster SHALL contain, in order: the model control, the reasoning-effort control (when the active model renders one), an overflow menu (`⋯`) containing the workspace control and the agent control, and the send/stop control as the rightmost element. Every control SHALL be reachable by keyboard and SHALL carry an accessible label resolved through the i18n bundle. Existing control `data-testid` contracts SHALL be preserved by the restructuring.

#### Scenario: strip renders in a connected session
- **WHEN** the chat view is mounted and the WebSocket status is `connected`
- **THEN** the composer SHALL render the single control row beneath the textarea with the left and right clusters in the stated order
- **AND** each control SHALL display the runtime's current value for that setting
- **AND** the send/stop control SHALL be the rightmost control in the row

#### Scenario: strip is disabled while disconnected
- **WHEN** the WebSocket status is not `connected`
- **THEN** every control in the row SHALL be disabled
- **AND** the textarea SHALL remain editable so the user can continue drafting

#### Scenario: agent control renders in the strip
- **WHEN** the control row renders in a connected session
- **THEN** the workspace control SHALL be offered inside the overflow menu
- **AND** the agent control SHALL be offered inside the same overflow menu whenever two or more switchable agents exist, displaying the name of the currently active agent
- **AND** the agent control SHALL offer every agent returned by the server's switchable-agent list

#### Scenario: keyboard reach and labels are preserved
- **WHEN** the user navigates the composer with the keyboard
- **THEN** the `+` button, permission, model, effort, overflow, and send/stop controls SHALL each be focusable and carry accessible labels
- **AND** controls inside the `+` and overflow menus SHALL be reachable once their menu is open

### Requirement: Commands control opens the existing slash-command picker
The `+` menu's commands entry SHALL trigger the same `SlashCommandPicker` used by typed `/` input, showing built-in commands and loaded skills in the existing sections. Selecting an entry SHALL insert its token into the textarea exactly as the typed path does. The `+` menu's attachment entry SHALL open the same file-selection and upload path the attachment button previously offered. No second command list or second upload path SHALL be maintained.

#### Scenario: plus menu offers attachment and commands
- **WHEN** the user activates the `+` button
- **THEN** the menu SHALL offer a file-attachment entry and a commands entry
- **AND** activating the attachment entry SHALL open the file selection dialog feeding the existing upload path

#### Scenario: clicking the commands control opens the picker
- **WHEN** the user activates the commands entry
- **THEN** the slash-command picker SHALL open showing all built-in commands and all loaded skills
- **AND** keyboard navigation, filtering, and Escape-to-dismiss SHALL behave identically to the typed-`/` path

#### Scenario: selecting a command inserts its token
- **WHEN** the user selects an entry from the picker opened via the menu
- **THEN** the entry's token SHALL be inserted into the textarea followed by a space
- **AND** focus SHALL return to the textarea
