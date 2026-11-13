## ADDED Requirements

### Requirement: i18n runtime initialized with a common namespace and English fallback
The React web shell SHALL initialize `react-i18next` before the application tree renders, configured with a single `common` namespace and resource bundles for the supported locales: `en`, `zh-CN`, `es`, `fr`, and `ja`. `en` SHALL be the source-of-truth and the `fallbackLng`; any translation key missing from the active locale's bundle SHALL resolve to the `en` value, and SHALL never throw or render an empty/raw key.

#### Scenario: i18n is ready before the app renders
- **WHEN** the web bundle loads
- **THEN** i18next SHALL be initialized with the `common` namespace and all supported locales
- **AND** the React tree SHALL mount only after initialization completes

#### Scenario: missing key falls back to English
- **WHEN** the active locale is `ja` and a key exists in `en/common.json` but not in `ja/common.json`
- **THEN** the UI SHALL render the English value for that key
- **AND** SHALL NOT render the raw key string or an empty node

### Requirement: Active locale is resolved by user choice, then browser language, then English
The shell SHALL resolve the active locale in priority order: (1) an explicit user choice persisted at `localStorage["platform.locale"]` if it names a supported locale; else (2) the best match of `navigator.languages` / `navigator.language` against the supported list, preferring an exact match (e.g. `zh-CN`) and then a primary-subtag match (e.g. `zh` -> `zh-CN`); else (3) `en`. A browser locale with no supported match SHALL resolve to `en`.

#### Scenario: explicit choice wins over browser language
- **WHEN** `localStorage["platform.locale"]` is `fr` and the browser language is `en-US`
- **THEN** the active locale SHALL be `fr`

#### Scenario: no stored choice falls back to browser language
- **WHEN** no `localStorage["platform.locale"]` is set and the browser language is `ja`
- **THEN** the active locale SHALL be `ja`

#### Scenario: unsupported browser locale falls back to English
- **WHEN** no stored choice is set and the browser language matches no supported locale
- **THEN** the active locale SHALL be `en`

### Requirement: Locale choice persists across reloads
The user's selected locale SHALL be written to `localStorage["platform.locale"]` and SHALL be reapplied as the active locale on the next page load. Persisting or changing the locale SHALL NOT require a server round-trip or a backend restart.

#### Scenario: choice persists across reloads
- **WHEN** the user selects `es` and then reloads the page
- **THEN** the active locale SHALL remain `es`
- **AND** the UI SHALL render in Spanish without further user action

#### Scenario: locale change needs no server restart
- **WHEN** the user switches locale from `en` to `zh-CN`
- **THEN** the UI SHALL re-render in Simplified Chinese immediately
- **AND** no request to restart `server.js` or any child service SHALL be made

### Requirement: Sidebar language switcher lists all supported locales
The sidebar SHALL expose a language-selection control (`data-testid="locale-select"`) whose options are the supported locales, each labeled by that locale's own-language display name (e.g. `English`, `简体中文`, `Español`, `Français`, `日本語`). Selecting an option SHALL set the active locale, persist it, and re-render the shell in the chosen locale.

#### Scenario: switcher lists every supported locale
- **WHEN** the sidebar renders
- **THEN** the locale select SHALL contain one option per supported locale
- **AND** each option's label SHALL be that locale's endonym

#### Scenario: selecting a locale switches the UI language
- **WHEN** the user selects `日本語` in the locale select
- **THEN** the active locale SHALL become `ja`
- **AND** `localStorage["platform.locale"]` SHALL be `ja`
- **AND** the shell SHALL re-render with Japanese strings

### Requirement: All user-visible frontend strings resolve through the i18n bundle
No component or page in `web/src` SHALL render a hard-coded user-visible display string; every such string SHALL be obtained via the i18n `t()` function against a stable key in the `common` namespace, with dynamic values passed as interpolation variables. Switching the active locale SHALL update every displayed string without a page reload.

#### Scenario: switching locale updates all displayed text
- **WHEN** the locale changes from `en` to `zh-CN`
- **THEN** every visible label, heading, placeholder, status text, and toast in the shell SHALL render its Simplified-Chinese value
- **AND** no English string SHALL remain visible for a key that has a `zh-CN` translation

#### Scenario: dynamic values are interpolated, not concatenated
- **WHEN** a string includes a variable (e.g. an uploaded file name)
- **THEN** the rendered value SHALL be produced by i18next interpolation (e.g. `Uploaded {{name}}`)
- **AND** SHALL NOT be assembled by JavaScript string concatenation of a translated fragment

### Requirement: Document language attribute reflects the active locale
On initialization and on every locale change, the shell SHALL set `document.documentElement.lang` to the resolved locale code (e.g. `zh-CN`) for accessibility and correct text rendering. The `dir` attribute SHALL be explicitly set to `ltr` so that a future right-to-left locale can be added with a single change.

#### Scenario: html lang follows the active locale
- **WHEN** the active locale is `fr`
- **THEN** `document.documentElement.lang` SHALL be `fr`

#### Scenario: locale switch updates html lang
- **WHEN** the user switches the locale from `en` to `ja`
- **THEN** `document.documentElement.lang` SHALL become `ja`
