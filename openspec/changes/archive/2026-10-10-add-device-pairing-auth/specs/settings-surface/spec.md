# settings-surface Delta

## MODIFIED Requirements

### Requirement: Settings modal surface

The web UI SHALL provide a Settings modal that overlays the current view rather than replacing it. The modal SHALL contain exactly eleven sections, in order: **General**, **Account**, **Models**, **MCP Servers**, **Skills**, **Packs**, **Custom presets**, **WeChat App**, **Paired devices**, **Deployment branding**, **System Status**. Each section SHALL be identified by a stable slug — `general`, `account`, `models`, `mcp`, `skills`, `packs`, `presets`, `wechat-app`, `devices`, `branding`, `status` — which forms part of its URL and SHALL NOT change. Section labels SHALL resolve from the internationalization resource bundle keyed by that stable slug, so the label follows the active locale while the slug, ordering, and icon remain stable.

The modal SHALL be dismissible and SHALL restore the user to the view they opened it from, with that view's scroll position preserved.

#### Scenario: modal overlays the current view

- **WHEN** the user opens Settings from the chat view
- **THEN** the Settings modal SHALL render above the chat view
- **AND** the chat view SHALL remain mounted beneath the modal
- **AND** the chat view SHALL NOT be unmounted or remounted

#### Scenario: canonical section set and ordering

- **WHEN** the Settings modal renders
- **THEN** it SHALL present the sections General, Account, Models, MCP Servers, Skills, Packs, Custom presets, WeChat App, Paired devices, Deployment branding, and System Status in that order
- **AND** each section label SHALL be resolved from the i18n bundle under a stable key
- **AND** the section slugs and ordering SHALL NOT change when the active locale changes

#### Scenario: dismissing restores the underlying view

- **WHEN** the Settings modal is open over a view and the user dismisses it
- **THEN** the modal SHALL close
- **AND** the underlying view SHALL become interactive again with its scroll position unchanged
