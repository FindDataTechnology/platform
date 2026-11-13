# deployment-branding delta

## Purpose

Extends deployment branding with a locale-aware `loginHero` slot group so the login page can present a product-grade split-screen hero (headline, subtitle, bullet points, optional image, link row) when configured — while an unconfigured deployment (the open-source default) renders the existing neutral single-column card unchanged. Marketing copy is configuration, never code.

## MODIFIED Requirements

### Requirement: Branding configuration surface

The system SHALL expose branding fields — `companyName`, `assistantName`, `brandIconUrl`, `loginFooterText`, and the `loginHero` slot group — via `GET /api/config`, which is reachable without authentication. Unset fields SHALL be `null`, and the web SHALL fall back to localized defaults / current behavior for each. Mutating the branding SHALL be exposed only to authenticated admins (the `admin` group when auth is on; open when auth is off, matching the existing admin-gate pattern), via a `PUT /api/config/branding` route that validates field types and rejects non-string / over-length values (each field capped at a documented bound). A successful write SHALL take effect on subsequent `GET /api/config` responses without a server restart.

`loginHero` SHALL be a locale-keyed object: keys restricted to the supported UI locales, each value carrying `title`, `subtitle`, `points` (an array of at most 4 short strings), `imageUrl` (optional), and `links` (an array of at most 4 `{label, url}` pairs; `url` SHALL be an absolute `http(s)` URL) — every sub-field optional, at least the locale map itself non-empty when present. The server SHALL validate the structure and bounds of `loginHero` as a whole and reject a write whose other fields are valid but whose `loginHero` is malformed, with no field persisted.

#### Scenario: anonymous config read

- **WHEN** an unauthenticated client calls `GET /api/config`
- **THEN** the response includes the branding fields with their currently stored values or `null`, including `loginHero`

#### Scenario: admin updates branding

- **WHEN** an authenticated `admin`-group user PUTs valid branding values
- **THEN** the write succeeds and the next `GET /api/config` returns the new values without a server restart

#### Scenario: non-admin write rejected

- **WHEN** auth is on and a non-admin authenticated user PUTs branding values
- **THEN** the server responds `403` and the stored branding is unchanged

#### Scenario: invalid values rejected

- **WHEN** a write contains a non-string value or a field exceeding its length bound
- **THEN** the server responds `4xx` and no field is persisted

#### Scenario: malformed hero structure rejected

- **WHEN** a write carries a `loginHero` with an unsupported locale key, more than 4 points, more than 4 links, a relative link URL, or a non-string title
- **THEN** the server responds `4xx`, names the offending locale and field, and no field is persisted

### Requirement: Env fallback seeding

When no stored value exists for a branding field, the system SHALL fall back to the corresponding environment variable (`COMPANY_NAME`, `ASSISTANT_NAME`, `BRAND_ICON_URL`, `LOGIN_FOOTER_TEXT`, and `LOGIN_HERO`), each optional. For `LOGIN_HERO` the variable SHALL hold the same JSON structure as the stored value and SHALL be ignored (with a logged warning, treating the field as unset) when it does not parse or fails the same structural validation. Resolution order is stored-value → env → localized default (or absence, for icon/footer/hero). The packaged desktop app's settings.json SHALL be able to supply the same variables with its usual precedence.

#### Scenario: env-only deployment

- **WHEN** no branding has been stored and `COMPANY_NAME=寻数科技` is set in the environment
- **THEN** `GET /api/config` reports `companyName: "寻数科技"`

#### Scenario: stored value wins over env

- **WHEN** a stored `companyName` exists and the environment also sets `COMPANY_NAME`
- **THEN** the stored value is served

#### Scenario: hero env JSON

- **WHEN** no `loginHero` is stored and `LOGIN_HERO` carries a valid locale-keyed JSON
- **THEN** `GET /api/config` reports the parsed `loginHero`

#### Scenario: unparseable hero env ignored

- **WHEN** `LOGIN_HERO` is set but does not parse as JSON or fails structural validation
- **THEN** `loginHero` reports `null` and the server logs a warning; startup and all other branding are unaffected

### Requirement: Branded login page

The login page SHALL render the brand icon (when configured) and use the company name in its descriptive copy; it SHALL render the configurable footer text below the login card when set, and SHALL NOT render a footer element when the text is unset. The login page SHALL include the language switcher so an anonymous user can change the UI language before signing in; the choice SHALL persist with the same mechanism as the in-app switcher.

When the resolved `loginHero` yields presentable hero content for the current UI locale, the login page SHALL render as a split layout: a hero panel carrying the headline, subtitle, points, and optional image, beside the login card; the hero panel's copy SHALL follow the locale resolution chain — the current UI locale's value, else the `en` locale's value, else no hero. When no hero content resolves, the page SHALL render the existing single-column card with no hero element and no layout change relative to current behavior. The hero link row SHALL render when configured, in split and single-column layouts alike, as a subtle row of links; a partially configured hero SHALL degrade per field (present fields render; absent fields collapse) without broken placeholders. The SSO entry, locale switcher, and error displays SHALL behave identically in both layouts.

#### Scenario: branded anonymous login

- **WHEN** branding is configured (company name, icon, footer) and an unauthenticated user opens `/login`
- **THEN** the page shows the icon, copy that references the company name, and the footer line

#### Scenario: unbranded login unchanged

- **WHEN** no branding is configured
- **THEN** the login page renders the localized defaults with no icon and no footer element

#### Scenario: anonymous language switch

- **WHEN** the user changes the language on the login page
- **THEN** the page re-renders in the chosen language and the choice persists for later visits

#### Scenario: configured hero renders split layout

- **WHEN** `loginHero` carries a `zh-CN` entry and the UI locale is `zh-CN`
- **THEN** the login page renders the hero panel (headline, subtitle, points, links) beside the login card, and the SSO entry and locale switcher keep their behavior

#### Scenario: hero follows locale fallback

- **WHEN** `loginHero` carries only an `en` entry and the UI locale is `ja`
- **THEN** the hero panel renders the `en` entry's copy

#### Scenario: unconfigured hero keeps the neutral card

- **WHEN** `loginHero` is null or empty
- **THEN** the login page renders the existing single-column card with no hero element, pixel-equivalent to the pre-change neutral form

#### Scenario: links row renders standalone

- **WHEN** `loginHero` carries only `links` (no headline, subtitle, points, or image)
- **THEN** no hero panel renders and the link row appears below the login card
