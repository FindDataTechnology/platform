# session-list-management Specification

## Purpose
Define how the sidebar session list is managed by the user — specifically, how sessions can be removed via a right-click context menu. The list itself (display, current-session highlight, "New" button) is owned by the chat shell; this capability covers the per-row actions surface.

## Requirements

### Requirement: Right-click context menu on each session row
Each session row in the sidebar SHALL expose a right-click context menu containing at minimum the action **Delete** (with confirmation). The menu SHALL open on `contextmenu` (right-click) and on `Shift+F10`. The menu SHALL be dismissable by clicking outside, pressing Escape, or selecting an item. The menu SHALL appear positioned to the row's pointer location and SHALL NOT overflow the viewport.

## ADDED Requirements

### Requirement: Right-click context menu on each session row
Each session row in the sidebar SHALL expose a right-click context menu containing at minimum the action **Delete** (with confirmation). The menu SHALL open on `contextmenu` (right-click) and on `Shift+F10`. The menu SHALL be dismissable by clicking outside, pressing Escape, or selecting an item. The menu SHALL appear positioned to the row's pointer location and SHALL NOT overflow the viewport.

#### Scenario: open menu on right-click
- **WHEN** the user right-clicks a session row
- **THEN** a context menu SHALL appear with the Delete entry
- **AND** the default browser context menu SHALL be suppressed

#### Scenario: dismiss without action
- **WHEN** the menu is open and the user presses Escape
- **THEN** the menu SHALL close without any session being modified

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
