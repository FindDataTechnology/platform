## REMOVED Requirements

### Requirement: Sidebar language switcher lists all supported locales

**Reason**: The language selector no longer lives in the sidebar. The sidebar footer collapsed to a single connection-status-and-gear row, and language is persistent configuration rather than a per-turn control, so it moved to the Settings surface alongside the theme setting. Keeping a requirement named for the sidebar would misdescribe where the control is.

**Migration**: The same control, with the same `data-testid="locale-select"` and the same endonym-labelled options, is rendered in the Settings General section at `/settings/general`. Its selection, persistence, and re-render behavior are unchanged — see the replacement requirement "Settings language switcher lists all supported locales". Tests and links that reached the control through the sidebar SHALL open Settings to the General section first; the `data-testid` itself does not change.

## ADDED Requirements

### Requirement: Settings language switcher lists all supported locales
The Settings surface's General section SHALL expose a language-selection control (`data-testid="locale-select"`) whose options are the supported locales, each labeled by that locale's own-language display name (e.g. `English`, `简体中文`, `Español`, `Français`, `日本語`). Selecting an option SHALL set the active locale, persist it, and re-render the shell in the chosen locale. The control SHALL NOT be rendered anywhere else in the application.

#### Scenario: switcher lists every supported locale
- **WHEN** the Settings surface is open on the General section
- **THEN** the locale select SHALL contain one option per supported locale
- **AND** each option's label SHALL be that locale's endonym

#### Scenario: selecting a locale switches the UI language
- **WHEN** the user selects `日本語` in the locale select
- **THEN** the active locale SHALL become `ja`
- **AND** `localStorage["platform.locale"]` SHALL be `ja`
- **AND** the shell SHALL re-render with Japanese strings, including the surface behind the Settings overlay

#### Scenario: switcher is not present in the sidebar
- **WHEN** the sidebar renders in any locale
- **THEN** it SHALL NOT contain a locale-selection control
