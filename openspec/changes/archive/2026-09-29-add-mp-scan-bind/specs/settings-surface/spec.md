## MODIFIED Requirements

### Requirement: Settings modal surface

The web UI SHALL provide a Settings modal that overlays the current view rather than replacing it. The modal SHALL contain exactly six sections, in order: **General**, **Models**, **MCP**, **Skills**, **WeChat App**, **System Status**. Each section SHALL be identified by a stable slug — `general`, `models`, `mcp`, `skills`, `wechat-app`, `status` — which forms part of its URL and SHALL NOT change. Section labels SHALL resolve from the internationalization resource bundle keyed by that stable slug, so the label follows the active locale while the slug, ordering, and icon remain stable.

The modal SHALL be dismissible and SHALL restore the user to the view they opened it from, with that view's scroll position preserved.

#### Scenario: modal overlays the current view

- **WHEN** the user opens Settings from the chat view
- **THEN** the Settings modal SHALL render above the chat view
- **AND** the chat view SHALL remain mounted beneath the modal
- **AND** the chat view SHALL NOT be unmounted or remounted

#### Scenario: canonical section set and ordering

- **WHEN** the Settings modal renders
- **THEN** it SHALL present the sections General, Models, MCP, Skills, WeChat App, and System Status in that order
- **AND** each section label SHALL be resolved from the i18n bundle under a stable key
- **AND** the section slugs and ordering SHALL NOT change when the active locale changes

#### Scenario: dismissing restores the underlying view

- **WHEN** the Settings modal is open over a view and the user dismisses it
- **THEN** the modal SHALL close
- **AND** the underlying view SHALL become interactive again with its scroll position unchanged

## ADDED Requirements

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
