## MODIFIED Requirements

### Requirement: Settings modal surface

The web UI SHALL provide a Settings modal that overlays the current view rather than replacing it. The modal SHALL organize its sections into three stable groups, in order — **Basics（常规）**, **Capabilities（能力）**, **Management（管理）** — holding the sections:

- Basics: **General**, **Account**, **WeChat App**, **Paired devices**
- Capabilities: **Tools & Skills（技能与工具）**, **Models**
- Management: **Channels（渠道接入）**, **Diagnostics（诊断）**, **System Status**, **Deployment branding**

Each section SHALL be identified by a stable slug which forms part of its URL and SHALL NOT change: `general`, `account`, `wechat-app`, `devices`, `mcp`, `models`, `channels`, `diagnostics`, `status`, `branding`. The merged Tools & Skills section SHALL additionally remain addressable at the legacy `skills` slug, with each of the two slugs (`mcp`, `skills`) opening the section with its corresponding sub-view active (tools vs skills), so existing deep links keep resolving. The former `packs` and `presets` sections are retired from Settings; their `/settings/packs` and `/settings/presets` URLs redirect to the corresponding `/agents` sub-tabs (per `agent-catalog`). Section labels SHALL resolve from the internationalization resource bundle keyed by the stable slug, so the label follows the active locale while the slug, ordering, and icon remain stable; user-facing zh-CN copy SHALL use user-language terms (技能与工具, 渠道接入, 诊断) and SHALL NOT surface developer vocabulary such as "MCP" in section labels.

The modal SHALL be dismissible and SHALL restore the user to the view they opened it from, with that view's scroll position preserved.

#### Scenario: modal overlays the current view

- **WHEN** the user opens Settings from the chat view
- **THEN** the Settings modal SHALL render above the chat view
- **AND** the chat view SHALL remain mounted beneath the modal
- **AND** the chat view SHALL NOT be unmounted or remounted

#### Scenario: canonical section set and ordering

- **WHEN** the Settings modal renders
- **THEN** it SHALL present the three groups Basics, Capabilities, and Management in that order, holding General, Account, WeChat App, Paired devices; Tools & Skills, Models; Channels, Diagnostics, System Status, Deployment branding
- **AND** each section label SHALL be resolved from the i18n bundle under a stable key
- **AND** the section slugs, grouping, and ordering SHALL NOT change when the active locale changes
- **AND** no Packs or Custom presets section SHALL be present

#### Scenario: dismissing restores the underlying view

- **WHEN** the Settings modal is open over a view and the user dismisses it
- **THEN** the modal SHALL close
- **AND** the underlying view SHALL become interactive again with its scroll position unchanged

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
| `/bots` | `/settings/channels` |
| `/trace` | `/settings/diagnostics` |

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

#### Scenario: demoted surface routes redirect

- **WHEN** the user navigates to `/bots`
- **THEN** the router SHALL redirect to `/settings/channels`
- **AND** the Settings modal SHALL open with the Channels section active
- **WHEN** the user navigates to `/trace`
- **THEN** the router SHALL redirect to `/settings/diagnostics`
- **AND** the Settings modal SHALL open with the Diagnostics section active

#### Scenario: no legacy path renders a pane at its old URL

- **WHEN** the user navigates to any legacy configuration route
- **THEN** the address bar SHALL show the canonical `/settings/:section` URL
- **AND** SHALL NOT remain on the legacy path

### Requirement: Settings sections reuse existing page components unchanged

The Models, Tools & Skills, and System Status sections SHALL render the existing page components for those surfaces; the Channels section SHALL render the existing bots management page component, and the Diagnostics section SHALL render the existing trace list page component. Their internal controls, behavior, REST calls, and `data-testid` attributes SHALL be unchanged — only the container changes from a full-width page to a modal section pane.

Section content SHALL be loaded lazily, so opening the modal mounts only the active section and not all of them.

#### Scenario: section content is unchanged from the standalone page

- **WHEN** the user opens the Models section in the Settings modal
- **THEN** the section SHALL render the same controls and `data-testid` attributes the standalone `/models` page rendered
- **AND** the controls SHALL behave identically
- **WHEN** the user opens the Channels section
- **THEN** the section SHALL render the same platform icon grid, bot cards, and `data-testid` attributes the standalone `/bots` page rendered

#### Scenario: only the active section mounts

- **WHEN** the Settings modal opens with one section active
- **THEN** only that section's component SHALL be mounted
- **AND** the other sections SHALL NOT be mounted until selected
