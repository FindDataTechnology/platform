## REMOVED Requirements

### Requirement: Sidebar model indicator is read-only

**Reason**: The sidebar chip was a third redundant surface for the same value. With the control strip designated the sole per-turn runtime-configuration surface (see `chat-composer-controls`) and provider/default configuration moved into the Settings surface, the chip displayed state that is already on screen in the strip whenever a turn can be sent, and its only action — navigating to `/models` — is now served by the Settings gear and `Cmd/Ctrl + ,`.

**Migration**: The active model and effort are displayed and changed in the composer control strip's model and reasoning-effort controls. Provider and default-model configuration moved from `/models` to the Settings Models section at `/settings/models`; the legacy `/models` route redirects there, so existing links and bookmarks continue to resolve. The sidebar's agent `<select>` referenced by this requirement is likewise removed — the agent control moved into the control strip.

## MODIFIED Requirements

### Requirement: Model and thinking level are selected together in the UI
The Settings Models section (`/settings/models`) SHALL present the thinking-level picker alongside (not separate from) the model selector for models that declare efforts, and the composer control strip SHALL display the active model and its non-default effort in adjacent controls so that the pair reads as one setting.

#### Scenario: combined selector
- **WHEN** the user opens the Settings Models section and selects a model with declared efforts
- **THEN** the effort picker SHALL be offered in the same selection flow, with "Default" preselected when no explicit effort is persisted

#### Scenario: strip reflects effort
- **WHEN** a non-default thinking level is active
- **THEN** the control strip's model control SHALL display the active model
- **AND** the adjacent reasoning-effort control SHALL display the active effort

#### Scenario: legacy models route resolves
- **WHEN** the user navigates to `/models`
- **THEN** the router SHALL redirect to `/settings/models`
- **AND** the Settings surface SHALL open on the Models section
