## ADDED Requirements

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
The Preferences window SHALL let the user view and edit: the Volces API key (`VOLCES_API_KEY`), the LiteLLM YAML config (contents of `userData/litellm.yaml`), and the LiteLLM API key (`LITELLM_API_KEY`, read-only display with copy button). The Volces base URL (`VOLCES_BASE_URL`) SHALL also be editable. Tokens for OpenConnector SHALL be visible as **rotatable** via a single "Regenerate" action but their values MUST NOT be displayed in the DOM.

#### Scenario: Edit Volces API key
- **WHEN** the user changes the Volces API key field and clicks Save
- **THEN** the main process writes the new value to `settings.json` atomically
- **AND** restarts `server.js` (and only `server.js`) so the new key takes effect

#### Scenario: Edit LiteLLM YAML
- **WHEN** the user edits the LiteLLM YAML textarea and clicks Save
- **THEN** the main process writes the new content to `userData/litellm.yaml` atomically
- **AND** restarts the LiteLLM child
- **AND** if the child fails its health check, the last 20 stderr lines are surfaced back to the Preferences window

#### Scenario: Rotate OpenConnector tokens
- **WHEN** the user clicks "Regenerate OpenConnector tokens"
- **THEN** the main process generates fresh 32-byte hex tokens
- **AND** writes them to `settings.json` atomically
- **AND** restarts both `openconnector` and `server.js` so the new tokens propagate
- **AND** the token values are NEVER sent to the Preferences renderer

### Requirement: IPC channel whitelist
The Preferences renderer SHALL communicate with the main process only via explicit IPC channels: `settings:get-visible`, `settings:set-field`, `litellm:get-config`, `litellm:set-config`, `openconnector:rotate-tokens`, `service:restart`. Each channel handler SHALL validate its input shape and refuse arbitrary keys.

#### Scenario: Attempt to read OC token via IPC
- **WHEN** the renderer invokes `settings:get-visible`
- **THEN** the returned object SHALL NOT include `OPENCONNECTOR_RUNTIME_TOKEN` or `OPENCONNECTOR_ADMIN_TOKEN`
- **AND** these keys are on a server-side blocklist

#### Scenario: Attempt to write arbitrary settings key
- **WHEN** the renderer invokes `settings:set-field` with an unknown key
- **THEN** the handler rejects the call with an error
- **AND** does NOT touch `settings.json`

### Requirement: Restart affects only impacted services
The Preferences window SHALL trigger the narrowest possible service restart for each change: Volces key change restarts `server.js`; LiteLLM YAML change restarts `litellm` only; OC token rotation restarts both `openconnector` and `server.js`. The Electron window MUST NOT be reloaded and the user's chat state SHALL be preserved insofar as the chat surface's WS auto-reconnect covers it.

#### Scenario: Volces key change does not restart LiteLLM
- **WHEN** the user saves a new Volces key
- **THEN** the main process restarts `server.js` only
- **AND** the LiteLLM child continues running with its existing state
