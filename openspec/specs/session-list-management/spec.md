# session-list-management Specification

## Purpose
TBD - created by archiving change ui-nav-restructure. Update Purpose after archive.
## Requirements
### Requirement: Right-click context menu on each session row
Each session row in the sidebar SHALL expose a right-click context menu containing at minimum the actions **Clear** and **Delete** (Delete with confirmation). The menu SHALL open on `contextmenu` (right-click) and on `Shift+F10`. The menu SHALL be dismissable by clicking outside, pressing Escape, or selecting an item. The menu SHALL appear positioned to the row's pointer location and SHALL NOT overflow the viewport.

The same menu SHALL be reachable for the active session from the chat header's overflow (`⋯`) trigger, so there is one menu component with two entry points.

#### Scenario: open menu on right-click
- **WHEN** the user right-clicks a session row
- **THEN** a context menu SHALL appear with the Clear and Delete entries
- **AND** the default browser context menu SHALL be suppressed

#### Scenario: dismiss without action
- **WHEN** the menu is open and the user presses Escape
- **THEN** the menu SHALL close without any session being modified

#### Scenario: chat header overflow opens the same menu
- **WHEN** the user activates the overflow (`⋯`) trigger in the chat header
- **THEN** the session context menu SHALL open for the active session
- **AND** it SHALL offer the same actions as the right-click menu on that session's row

### Requirement: Delete action with confirmation
Selecting **Delete** from the session context menu SHALL open a confirmation dialog ("Delete this chat? This cannot be undone." with Cancel / Delete buttons). On confirm, the client SHALL call `DELETE /api/chat-history/sessions/:id`. On success, the row SHALL disappear from the list (the broadcast `sessions` event updates the store). On failure, the client SHALL show an inline error and the row SHALL remain.

#### Scenario: confirm and delete
- **WHEN** the user clicks Delete in the context menu
- **AND** confirms in the dialog
- **THEN** the client SHALL call `DELETE /api/chat-history/sessions/<id>`
- **AND** on a 200 response, the session row SHALL be removed from the list
- **AND** on a non-2xx response, an inline error message SHALL be shown and the row SHALL remain

#### Scenario: cancel keeps the session
- **WHEN** the user clicks Delete and then Cancel in the dialog
- **THEN** no request SHALL be sent
- **AND** the session row SHALL remain unchanged

### Requirement: Active session cannot be deleted from the menu
If the right-clicked session is the current/active session, the Delete entry SHALL be disabled (greyed out) with a tooltip explaining "Switch to another session first". This mirrors the server-side 409 — the UI prevents the obviously-wrong action.

#### Scenario: delete disabled on active session
- **WHEN** the user opens the context menu on the currently active session
- **THEN** the Delete entry SHALL be disabled and show the tooltip
- **AND** clicking it SHALL NOT trigger any request

### Requirement: Clear action in the session context menu
Selecting **Clear** from the session context menu SHALL clear the displayed turns for that session in the client view. The action SHALL be available from both the right-click menu on a session row and the chat header overflow menu.

Clear operates on the DISPLAYED conversation, so it SHALL be enabled only for the currently active session and SHALL be disabled with an explanatory tooltip on any other row. Without that guard, clearing an inactive row would silently wipe the active conversation's view instead — the mirror of the Delete entry, which is disabled on the active session for the same class of reason.

This action was previously a permanently-visible "Clear chat" button in the sidebar footer. Moving it into the context menu places it beside Delete, where destructive session actions belong, and reclaims the footer space.

#### Scenario: clear from the context menu
- **WHEN** the user selects Clear from the active session's context menu
- **THEN** the displayed turns for that session SHALL be cleared from the view

#### Scenario: clear is disabled on a non-active session
- **WHEN** the user opens the context menu on a session that is not the active one
- **THEN** the Clear entry SHALL be disabled and show a tooltip directing the user to switch to that chat first
- **AND** activating it SHALL NOT clear the active session's view

#### Scenario: no standing clear button in the sidebar footer
- **WHEN** the sidebar renders
- **THEN** the footer SHALL NOT contain a "Clear chat" button
- **AND** the clear action SHALL be reachable only from the session context menu

