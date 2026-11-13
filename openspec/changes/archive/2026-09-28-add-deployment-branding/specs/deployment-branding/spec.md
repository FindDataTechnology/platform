# deployment-branding Specification

## Purpose

Deployment-editable branding (company name, assistant name, brand icon URL, login footer text) so an operator can rebrand the login page and tab without editing code, and an open-source fork can configure their own identity. Runtime storage with admin editing and env fallback; the login page and browser chrome consume it.

## ADDED Requirements

### Requirement: Branding configuration surface

The system SHALL expose branding fields — `companyName`, `assistantName`, `brandIconUrl`, `loginFooterText` — via `GET /api/config`, which is reachable without authentication. Unset fields SHALL be `null`, and the web SHALL fall back to localized defaults / current behavior for each. Mutating the branding SHALL be exposed only to authenticated admins (the `admin` group when auth is on; open when auth is off, matching the existing admin-gate pattern), via a `PUT /api/config/branding` route that validates field types and rejects non-string / over-length values (each field capped at a documented bound). A successful write SHALL take effect on subsequent `GET /api/config` responses without a server restart.

#### Scenario: anonymous config read

- **WHEN** an unauthenticated client calls `GET /api/config`
- **THEN** the response includes the four branding fields with their currently stored values or `null`

#### Scenario: admin updates branding

- **WHEN** an authenticated `admin`-group user PUTs valid branding values
- **THEN** the write succeeds and the next `GET /api/config` returns the new values without a server restart

#### Scenario: non-admin write rejected

- **WHEN** auth is on and a non-admin authenticated user PUTs branding values
- **THEN** the server responds `403` and the stored branding is unchanged

#### Scenario: invalid values rejected

- **WHEN** a write contains a non-string value or a field exceeding its length bound
- **THEN** the server responds `4xx` and no field is persisted

### Requirement: Env fallback seeding

When no stored value exists for a branding field, the system SHALL fall back to the corresponding environment variable (`COMPANY_NAME`, `ASSISTANT_NAME`, `BRAND_ICON_URL`, `LOGIN_FOOTER_TEXT`), each optional. Resolution order is stored-value → env → localized default (or absence, for icon/footer). The packaged desktop app's settings.json SHALL be able to supply the same variables with its usual precedence.

#### Scenario: env-only deployment

- **WHEN** no branding has been stored and `COMPANY_NAME=寻数科技` is set in the environment
- **THEN** `GET /api/config` reports `companyName: "寻数科技"`

#### Scenario: stored value wins over env

- **WHEN** a stored `companyName` exists and the environment also sets `COMPANY_NAME`
- **THEN** the stored value is served

### Requirement: Branded login page

The login page SHALL render the brand icon (when configured) and use the company name in its descriptive copy; it SHALL render the configurable footer text below the login card when set, and SHALL NOT render a footer element when the text is unset. The login page SHALL include the language switcher so an anonymous user can change the UI language before signing in; the choice SHALL persist with the same mechanism as the in-app switcher.

#### Scenario: branded anonymous login

- **WHEN** branding is configured (company name, icon, footer) and an unauthenticated user opens `/login`
- **THEN** the page shows the icon, copy that references the company name, and the footer line

#### Scenario: unbranded login unchanged

- **WHEN** no branding is configured
- **THEN** the login page renders the localized defaults with no icon and no footer element

#### Scenario: anonymous language switch

- **WHEN** the user changes the language on the login page
- **THEN** the page re-renders in the chosen language and the choice persists for later visits

### Requirement: Browser tab identity

When `assistantName` or `brandIconUrl` is configured, the web SHALL apply them to the browser tab: the tab title follows `assistantName` (existing behavior), and the tab favicon follows `brandIconUrl` via an injected icon link at boot. When `brandIconUrl` is unset, the system SHALL NOT inject an icon link (current no-icon behavior is preserved, no request to a default third-party URL).

#### Scenario: favicon injected

- **WHEN** the app loads with `brandIconUrl` configured
- **THEN** the browser tab shows that icon

#### Scenario: no icon configured

- **WHEN** the app loads with `brandIconUrl` unset
- **THEN** no icon link is injected and the tab keeps the browser default

### Requirement: Desktop build branding

The desktop release build SHALL honor `PRODUCT_NAME` (installer/app display name, default `Platform`), and an icon supplied as a build input (default: the vendored fd icon in-repo; overridable via `ICON_URL` which the build downloads once). Forks that set the variables SHALL produce installers with their own name and icon without editing source. An unreachable `ICON_URL` at build time SHALL fall back to the vendored icon with a warning, not fail the build.

#### Scenario: fork builds own brand

- **WHEN** a fork sets `PRODUCT_NAME` and `ICON_URL` and runs the release build
- **THEN** the produced dmg/exe carries that name and icon

#### Scenario: icon download fails

- **WHEN** `ICON_URL` is unreachable during a release build
- **THEN** the build completes using the vendored default icon and logs a warning

#### Scenario: unset variables keep defaults

- **WHEN** no build variables are set
- **THEN** the build produces the current `Platform` name with the vendored fd icon
