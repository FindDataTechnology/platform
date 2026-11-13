## ADDED Requirements

### Requirement: Mobile compact header shows the interpolated brand name

The chat page's mobile compact header (the `md:hidden` bar with the navigation drawer toggle) SHALL display the deployment's brand name resolved through the i18n interpolation chain (`sidebar.brand` + `{ brand }` from `useBranding()`, i.e. branding config's `assistantName` falling back to the `assistant.brand` locale value). The header SHALL NOT, under any locale or branding state, render a raw i18n placeholder (e.g. `{{brand}}`).

#### Scenario: mobile header renders the brand name

- **WHEN** the chat page renders at a mobile viewport (below the `md` breakpoint) with branding configured
- **THEN** the compact header next to the drawer toggle SHALL display the interpolated brand name (same value the desktop sidebar's brand line displays)
- **AND** SHALL NOT display the raw string `{{brand}}`

#### Scenario: brand falls back to the locale default

- **WHEN** no branding override (`assistantName`) is configured
- **THEN** the compact header SHALL display the locale's default brand value (e.g. `Platform` for zh-CN/en)
- **AND** the displayed value SHALL match the desktop sidebar brand line for the same state
