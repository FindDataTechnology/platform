## ADDED Requirements

### Requirement: Three-way theme selection

The web UI SHALL support three theme choices: **light**, **dark**, and **system**. The `system` choice SHALL follow the operating system's `prefers-color-scheme` setting and SHALL track changes to it live, without requiring a reload. When no choice has been made, the effective default SHALL be `system`.

The theme control SHALL live in the Settings modal's General section and SHALL be the only place the theme is changed.

#### Scenario: switching to light

- **WHEN** the user selects the light theme in Settings → General
- **THEN** the application SHALL render with the light palette immediately
- **AND** no reload SHALL be required

#### Scenario: switching to dark

- **WHEN** the user selects the dark theme in Settings → General
- **THEN** the application SHALL render with the dark palette immediately

#### Scenario: system follows the OS preference live

- **WHEN** the user has selected the system theme and the operating system's color scheme changes from dark to light
- **THEN** the application SHALL switch to the light palette without a reload

#### Scenario: default with no stored choice

- **WHEN** a user loads the application for the first time with no stored theme choice
- **THEN** the effective theme SHALL be system
- **AND** the rendered palette SHALL match the operating system's `prefers-color-scheme`

### Requirement: Theme choice persists across sessions

An explicit theme choice SHALL persist in browser local storage and SHALL be reapplied on subsequent loads, including after a full page reload and after the application is closed and reopened. The absence of a stored value SHALL be interpreted as `system` — the default SHALL NOT be written to storage on first load.

#### Scenario: explicit choice survives reload

- **WHEN** the user selects the light theme and then reloads the page
- **THEN** the application SHALL render with the light palette
- **AND** the theme control SHALL show light as the current selection

#### Scenario: system choice is the absence of a stored value

- **WHEN** the user selects the system theme
- **THEN** no explicit light or dark value SHALL remain in storage
- **AND** subsequent loads SHALL resolve the theme from `prefers-color-scheme`

### Requirement: No flash of incorrect theme on first paint

The application SHALL NOT render any frame in the wrong theme during initial load. A stored explicit theme SHALL be applied before the first paint, ahead of the application bundle executing. The `system` case SHALL require no JavaScript to resolve correctly.

#### Scenario: stored light theme does not flash dark

- **WHEN** a user with a stored light theme loads the application
- **THEN** the first painted frame SHALL use the light palette
- **AND** no dark-palette frame SHALL be rendered at any point during load

#### Scenario: system theme resolves without scripting

- **WHEN** a user with no stored theme choice loads the application under a light operating system preference
- **THEN** the first painted frame SHALL use the light palette
- **AND** the correct palette SHALL apply even before the application bundle has executed

### Requirement: Semantic tokens are the sole source of color

Every surface, text, border, and accent color SHALL resolve through the semantic design tokens defined in the stylesheet. No component SHALL hardcode a literal color that does not adapt to the active theme. Both palettes SHALL define the same complete token set, so no token is undefined in either theme.

The document's `color-scheme` SHALL reflect the active theme, so native form controls, scrollbars, and other user-agent-rendered chrome match the application palette.

#### Scenario: no hardcoded colors survive a theme switch

- **WHEN** the user switches between the light and dark themes
- **THEN** every surface, text, border, and accent color SHALL change to the corresponding value in the target palette
- **AND** no element SHALL retain a color from the previous palette

#### Scenario: both palettes define the same tokens

- **WHEN** either palette is active
- **THEN** every semantic token SHALL resolve to a defined value
- **AND** no token SHALL be undefined or fall back to an unstyled default

#### Scenario: native chrome matches the theme

- **WHEN** the light theme is active
- **THEN** native scrollbars and form controls SHALL render in their light variant
- **AND** SHALL NOT render dark against light surfaces

### Requirement: Code highlighting follows the active theme

Syntax-highlighted code blocks in rendered Markdown SHALL use a light highlighting theme when the light palette is active and a dark highlighting theme when the dark palette is active. Switching themes SHALL update already-rendered code blocks without re-highlighting them and without any asynchronous work — the switch SHALL be immediate.

#### Scenario: code blocks switch with the theme

- **WHEN** a conversation containing a highlighted code block is on screen and the user switches from dark to light
- **THEN** the code block SHALL render with light-theme syntax colors
- **AND** the code block SHALL NOT briefly render dark colors on a light surface

#### Scenario: switching does not re-highlight

- **WHEN** the user switches themes with highlighted code blocks on screen
- **THEN** the switch SHALL apply immediately
- **AND** SHALL NOT trigger re-highlighting or any asynchronous load

### Requirement: Both themes meet legibility standards on every surface

Every view SHALL be legible in both themes. Text SHALL meet WCAG AA contrast against its background in both palettes, and interactive states — hover, focus, active, disabled, selected — SHALL remain visually distinguishable in both.

#### Scenario: all views are legible in light mode

- **WHEN** the light theme is active
- **THEN** every nav surface and every Settings section SHALL render with legible text against its background
- **AND** no surface SHALL render light text on a light background

#### Scenario: interactive states remain distinguishable

- **WHEN** either theme is active
- **THEN** the hover, focus, active, disabled, and selected states of a control SHALL each be visually distinguishable from its resting state
