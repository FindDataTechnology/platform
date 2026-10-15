# preferences-ui Specification

## Purpose

Defines the desktop app's Preferences window: how it is opened, how its renderer is sandboxed, which settings the user may view and edit, the IPC surface between the renderer and the Electron main process, and how saving a setting restarts the affected service.

## Requirements

### Requirement: Preferences window
The app SHALL provide a Preferences window accessible from the Electron application menu (macOS: `App → Preferences…`, shortcut `⌘,`). The window SHALL be a separate `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, and no direct filesystem access from its renderer.

#### Scenario: Opening Preferences
- **WHEN** the user selects `Preferences…` from the app menu OR presses `⌘,`
- **THEN** the main process opens the Preferences BrowserWindow
- **AND** the window loads a local HTML file from the app bundle (not a remote URL)

#### Scenario: Preferences renderer is sandboxed
- **WHEN** the Preferences window is open
- **THEN** its renderer has no Node integration
- **AND** it can only invoke IPC channels explicitly exposed via `contextBridge`

### Requirement: Editable settings surface
The Preferences window SHALL let the user view and edit the Volces API key (`VOLCES_API_KEY`) and the Volces base URL (`VOLCES_BASE_URL`).

#### Scenario: Edit Volces API key
- **WHEN** the user changes the Volces API key field and clicks Save
- **THEN** the main process writes the new value to `settings.json` atomically
- **AND** restarts `server.js` so the new key takes effect

#### Scenario: Edit Volces base URL
- **WHEN** the user changes the Volces base URL field and clicks Save
- **THEN** the main process writes the new value to `settings.json` atomically
- **AND** restarts `server.js` so the new base URL takes effect

### Requirement: IPC channel whitelist
The Preferences renderer SHALL communicate with the main process only via explicit IPC channels: `settings:get-visible`, `settings:set-field`, `service:restart`. Each channel handler SHALL validate its input shape and refuse arbitrary keys.

#### Scenario: Attempt to write arbitrary settings key
- **WHEN** the renderer invokes `settings:set-field` with an unknown key
- **THEN** the handler rejects the call with an error
- **AND** does NOT touch `settings.json`

#### Scenario: Undeclared channel is not reachable
- **WHEN** the renderer attempts to invoke an IPC channel outside the whitelist
- **THEN** no handler SHALL respond
- **AND** the main process SHALL NOT perform any action

### Requirement: Restart affects only impacted services
The Preferences window SHALL trigger the narrowest possible service restart for each change: a settings change restarts `server.js`. The Electron window MUST NOT be reloaded and the user's chat state SHALL be preserved insofar as the chat surface's WS auto-reconnect covers it.

#### Scenario: Saving a setting restarts only the backend
- **WHEN** the user saves a new Volces key
- **THEN** the main process restarts `server.js` only
- **AND** the Electron window SHALL NOT be reloaded
- **AND** the chat surface SHALL recover via its WebSocket auto-reconnect
