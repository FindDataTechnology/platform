# settings-surface Specification

## Purpose

Defines the in-app Settings modal: a single overlay surface that hosts the application's configuration sections (General, Account, Models, MCP Servers, Skills, Packs, WeChat App, Deployment branding, System Status), its `/settings/:section` routing and deep-link behavior, its open and dismiss affordances, and the redirects that retire the former standalone configuration pages.

## Requirements

### Requirement: Settings modal surface

The web UI SHALL provide a Settings modal that overlays the current view rather than replacing it. The modal SHALL contain exactly nine sections, in order: **General**, **Account**, **Models**, **MCP Servers**, **Skills**, **Packs**, **WeChat App**, **Deployment branding**, **System Status**. Each section SHALL be identified by a stable slug — `general`, `account`, `models`, `mcp`, `skills`, `packs`, `wechat-app`, `branding`, `status` — which forms part of its URL and SHALL NOT change. Section labels SHALL resolve from the internationalization resource bundle keyed by that stable slug, so the label follows the active locale while the slug, ordering, and icon remain stable.

The modal SHALL be dismissible and SHALL restore the user to the view they opened it from, with that view's scroll position preserved.

#### Scenario: modal overlays the current view

- **WHEN** the user opens Settings from the chat view
- **THEN** the Settings modal SHALL render above the chat view
- **AND** the chat view SHALL remain mounted beneath the modal
- **AND** the chat view SHALL NOT be unmounted or remounted

#### Scenario: canonical section set and ordering

- **WHEN** the Settings modal renders
- **THEN** it SHALL present the sections General, Account, Models, MCP Servers, Skills, Packs, WeChat App, Deployment branding, and System Status in that order
- **AND** each section label SHALL be resolved from the i18n bundle under a stable key
- **AND** the section slugs and ordering SHALL NOT change when the active locale changes

#### Scenario: dismissing restores the underlying view

- **WHEN** the Settings modal is open over a view and the user dismisses it
- **THEN** the modal SHALL close
- **AND** the underlying view SHALL become interactive again with its scroll position unchanged

### Requirement: Settings sections are addressable at `/settings/:section`

Each Settings section SHALL be addressable at the route `/settings/<slug>`. Navigating to such a URL SHALL open the modal with that section active. The route `/settings` with no section SHALL resolve to `/settings/general`. An unrecognized section slug SHALL resolve to `/settings/general` rather than rendering an empty modal or a 404.

Switching sections within the open modal SHALL update the URL so the browser's back button returns to the previously viewed section, and so the current section can be copied as a link.

When the modal is opened from within the app, the underlying view SHALL be carried as the modal's background location. When a `/settings/:section` URL is loaded directly — a fresh page load, a bookmark, or a deep link — there is no background location, and the modal SHALL render over the `/chat` view.

#### Scenario: deep link opens a section directly

- **WHEN** the user loads `/settings/models` directly in a new browser tab
- **THEN** the Settings modal SHALL open with the Models section active
- **AND** the chat view SHALL render beneath the modal as the background

#### Scenario: bare `/settings` resolves to General

- **WHEN** the user navigates to `/settings`
- **THEN** the router SHALL resolve to `/settings/general`
- **AND** the General section SHALL be active

#### Scenario: unknown section falls back to General

- **WHEN** the user navigates to `/settings/nonexistent`
- **THEN** the router SHALL resolve to `/settings/general`
- **AND** the General section SHALL be active

#### Scenario: switching sections updates the URL

- **WHEN** the Settings modal is open at `/settings/general` and the user selects the MCP section
- **THEN** the URL SHALL become `/settings/mcp`
- **AND** the MCP section SHALL be active
- **AND** pressing the browser back button SHALL return to `/settings/general` with the General section active

### Requirement: Settings modal open and dismiss affordances

The Settings modal SHALL be openable from a gear control in the sidebar footer and by the keyboard shortcut `Cmd + ,` on macOS / `Ctrl + ,` on other platforms. The shortcut SHALL be active from any view in the application.

The modal SHALL be dismissible by pressing `Escape`, by clicking the backdrop outside the modal, and by activating an explicit close control. Every dismissal path SHALL navigate back to the background location rather than leaving a `/settings/*` URL in the address bar.

While the modal is open, focus SHALL be trapped within it, and on close focus SHALL return to the control that opened it.

#### Scenario: keyboard shortcut opens Settings from any view

- **WHEN** the user is on any view and presses `Cmd + ,` (macOS) or `Ctrl + ,` (other platforms)
- **THEN** the Settings modal SHALL open
- **AND** the URL SHALL become a `/settings/:section` route

#### Scenario: gear control opens Settings

- **WHEN** the user activates the gear control in the sidebar footer
- **THEN** the Settings modal SHALL open

#### Scenario: Escape dismisses and restores the URL

- **WHEN** the Settings modal is open over `/chat/abc123` and the user presses `Escape`
- **THEN** the modal SHALL close
- **AND** the URL SHALL return to `/chat/abc123`

#### Scenario: backdrop click dismisses

- **WHEN** the Settings modal is open and the user clicks the backdrop outside the modal panel
- **THEN** the modal SHALL close
- **AND** the URL SHALL return to the background location

#### Scenario: focus is trapped and restored

- **WHEN** the Settings modal is open
- **THEN** keyboard focus SHALL remain within the modal
- **AND** when the modal closes, focus SHALL return to the control that opened it

### Requirement: Legacy configuration routes redirect into Settings

The standalone routes that previously hosted configuration pages SHALL redirect to their Settings section equivalents so existing deep links and bookmarks continue to resolve. The redirect SHALL be to one canonical URL per section; no legacy path SHALL render a section pane at its old URL.

| Legacy route | Redirects to |
|---|---|
| `/models` | `/settings/models` |
| `/mcp` | `/settings/mcp` |
| `/skills` | `/settings/skills` |
| `/extensions` | `/settings/mcp` |
| `/extensions/mcp` | `/settings/mcp` |
| `/extensions/skills` | `/settings/skills` |
| `/dashboard` | `/settings/status` |

#### Scenario: legacy model route redirects

- **WHEN** the user navigates to `/models`
- **THEN** the router SHALL redirect to `/settings/models`
- **AND** the Settings modal SHALL open with the Models section active

#### Scenario: legacy extension routes redirect

- **WHEN** the user navigates to `/mcp`, `/extensions`, or `/extensions/mcp`
- **THEN** the router SHALL redirect to `/settings/mcp`
- **WHEN** the user navigates to `/skills` or `/extensions/skills`
- **THEN** the router SHALL redirect to `/settings/skills`

#### Scenario: legacy dashboard route redirects

- **WHEN** the user navigates to `/dashboard`
- **THEN** the router SHALL redirect to `/settings/status`
- **AND** the Settings modal SHALL open with the System Status section active

#### Scenario: no legacy path renders a pane at its old URL

- **WHEN** the user navigates to any legacy configuration route
- **THEN** the address bar SHALL show the canonical `/settings/:section` URL
- **AND** SHALL NOT remain on the legacy path

### Requirement: Settings sections reuse existing page components unchanged

The Models, MCP, Skills, and System Status sections SHALL render the existing page components for those surfaces. Their internal controls, behavior, REST calls, and `data-testid` attributes SHALL be unchanged — only the container changes from a full-width page to a modal section pane.

Section content SHALL be loaded lazily, so opening the modal mounts only the active section and not all five.

#### Scenario: section content is unchanged from the standalone page

- **WHEN** the user opens the Models section in the Settings modal
- **THEN** the section SHALL render the same controls and `data-testid` attributes the standalone `/models` page rendered
- **AND** the controls SHALL behave identically

#### Scenario: only the active section mounts

- **WHEN** the Settings modal opens with one section active
- **THEN** only that section's component SHALL be mounted
- **AND** the other four sections SHALL NOT be mounted until selected

### Requirement: General section hosts appearance and language preferences

The General section SHALL host the theme control and the locale control. These are the two preferences that previously had no home or occupied permanent space in the sidebar footer.

#### Scenario: General section presents theme and language

- **WHEN** the user opens the General section
- **THEN** the section SHALL present a theme control offering light, dark, and system
- **AND** the section SHALL present a locale control listing the supported locales

### Requirement: The WeChat App section carries the binding QR and code

The Settings modal SHALL provide a dedicated `wechat-app` section (route
`/settings/wechat-app`) that pairs the current account with the WeChat mini
program. For a signed-in user it SHALL mint the single-use 6-digit bind code
from the existing `/api/mp/bindcode` endpoint and present BOTH forms side by
side: the numeric code for manual entry and a QR encoding of
`<origin>/settings/wechat-app?bindcode=<code>`, so one secret serves scan
and type alike. The QR SHALL be rendered client-side (no image upload, no
new server route) and SHALL re-render on refresh. The section SHALL state
the code's validity (single use, 5 minutes) and that scanning happens in the
mini program's login page （扫码绑定）. Manual refresh SHALL always be
available; expiry after refresh SHALL be discoverable by the user (a visible
timer or re-mint on refresh). On a deployment where the endpoint is absent
or unauthenticated, the section SHALL degrade to an explanatory hint rather
than an error, and SHALL NOT block the rest of Settings.

#### Scenario: the section shows code and QR together

- **WHEN** a signed-in user opens Settings → WeChat App
- **THEN** a freshly minted 6-digit code and a QR encoding `<origin>/settings/wechat-app?bindcode=<code>` are both visible
- **AND** the QR decodes to exactly that URL

#### Scenario: refresh re-mints

- **WHEN** the user taps the refresh affordance
- **THEN** a new single-use code is minted and both the digits and the QR update

#### Scenario: degraded on deployments without the endpoint

- **WHEN** the section renders where `/api/mp/bindcode` is unavailable
- **THEN** it shows an explanatory hint and no broken controls
- **AND** the other Settings sections remain fully usable
