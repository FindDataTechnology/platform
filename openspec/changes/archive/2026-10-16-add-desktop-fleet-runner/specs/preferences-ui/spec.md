# preferences-ui — Spec Delta

## MODIFIED Requirements

### Requirement: Editable settings surface
The Preferences window SHALL let the user view and edit the Volces API key (`VOLCES_API_KEY`) and the Volces base URL (`VOLCES_BASE_URL`). It SHALL additionally expose the Wanxing fleet plugin settings (openspec: desktop-fleet-runner): the enable switch (`WANXING_PLUGIN_ENABLED`), the serving registry URL (`AGENT_SERVING_REGISTRY_URL`), and the serving registry token (`AGENT_SERVING_REGISTRY_TOKEN`). Saving these SHALL write `settings.json` atomically and SHALL inform the user that an application restart is required for the plugin switch to take effect (the supervisor resolves `enabled` at construction).

#### Scenario: Edit Volces API key
- **WHEN** the user changes the Volces API key field and clicks Save
- **THEN** the main process writes the new value to `settings.json` atomically
- **AND** restarts `server.js` so the new key takes effect

#### Scenario: Edit Volces base URL
- **WHEN** the user changes the Volces base URL field and clicks Save
- **THEN** the main process writes the new value to `settings.json` atomically
- **AND** restarts `server.js` so the new base URL takes effect

#### Scenario: Toggle the Wanxing fleet plugin

- **WHEN** the user toggles the Wanxing fleet switch, fills the registry fields, and clicks Save
- **THEN** the main process writes the values to `settings.json` atomically
- **AND** the surface states that restarting the application is required for the switch to take effect

#### Scenario: Registry token is not echoed in cleartext

- **WHEN** the preferences surface loads with a saved registry token
- **THEN** the token field presents a masked placeholder rather than the raw secret, matching the existing secret-field treatment
