## ADDED Requirements

### Requirement: First-party content pages resolve all visible strings through the i18n bundle
The first-party React pages and their sub-components SHALL resolve every user-visible label, heading, placeholder, status text, and toast through the `t()` function against the `common` namespace. This explicitly includes the Documents page (`DocumentsPage`, `IngestSection`, `QuerySection`, `CollectionsSection`, `DocRow`) and the `Composer` upload-result toasts. URL-example placeholders (e.g. `https://example.com/page`) and slash-command tokens (`/model`, `/new`) are identifiers, not prose, and SHALL remain literal. Dynamic values (e.g. an uploaded file name or error message) SHALL be passed as interpolation variables, not concatenated. No new translation keys SHALL be required when the existing `documents.*` and `composer.*` keys already cover the strings; locale parity SHALL remain enforced by the `check:locales` build guard.

#### Scenario: Documents page renders no hard-coded prose
- **WHEN** the Documents page renders in any supported locale
- **THEN** every visible label, heading, placeholder, and status text SHALL come from `t()`
- **AND** URL-example placeholders and slash-command tokens SHALL remain literal

#### Scenario: Composer upload toasts are localized
- **WHEN** a file upload succeeds or fails in the Composer
- **THEN** the toast SHALL use `t("composer.uploaded", { name })` or `t("composer.uploadFailed", { message })`
- **AND** the file name / error message SHALL be interpolated, not concatenated
