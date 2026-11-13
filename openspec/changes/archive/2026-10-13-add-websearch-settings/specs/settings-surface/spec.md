## MODIFIED Requirements

### Requirement: Settings modal surface

The web UI SHALL provide a Settings modal that overlays the current view rather than replacing it. The modal SHALL organize its sections into three stable groups, in order — **Basics（常规）**, **Capabilities（能力）**, **Management（管理）** — holding the sections:

- Basics: **General**, **Account**, **WeChat App**, **Paired devices**
- Capabilities: **Tools & Skills（技能与工具）**, **Network search（网络搜索）**, **Models**
- Management: **Channels（渠道接入）**, **Diagnostics（诊断）**, **System Status**, **Deployment branding**

Each section SHALL be identified by a stable slug which forms part of its URL and SHALL NOT change: `general`, `account`, `wechat-app`, `devices`, `mcp`, `models`, `websearch`, `channels`, `diagnostics`, `status`, `branding`. The merged Tools & Skills section SHALL additionally remain addressable at the legacy `skills` slug, with each of the two slugs (`mcp`, `skills`) opening the section with its corresponding sub-view active (tools vs skills), so existing deep links keep resolving. The former `packs` and `presets` sections are retired from Settings; their `/settings/packs` and `/settings/presets` URLs redirect to the corresponding `/agents` sub-tabs (per `agent-catalog`). Section labels SHALL resolve from the internationalization resource bundle keyed by the stable slug, so the label follows the active locale while the slug, ordering, and icon remain stable; user-facing zh-CN copy SHALL use user-language terms (技能与工具, 网络搜索, 渠道接入, 诊断) and SHALL NOT surface developer vocabulary such as "MCP" in section labels.

The modal SHALL be dismissible and SHALL restore the user to the view they opened it from, with that view's scroll position preserved.

#### Scenario: modal overlays the current view

- **WHEN** the user opens Settings from the chat view
- **THEN** the Settings modal SHALL render above the chat view
- **AND** the chat view SHALL remain mounted beneath the modal
- **AND** the chat view SHALL NOT be unmounted or remounted

#### Scenario: canonical section set and ordering

- **WHEN** the Settings modal renders
- **THEN** it SHALL present the three groups Basics, Capabilities, and Management in that order, holding General, Account, WeChat App, Paired devices; Tools & Skills, Network search, Models; Channels, Diagnostics, System Status, Deployment branding
- **AND** each section label SHALL be resolved from the i18n bundle under a stable key
- **AND** the section slugs, grouping, and ordering SHALL NOT change when the active locale changes
- **AND** no Packs or Custom presets section SHALL be present

#### Scenario: dismissing restores the underlying view

- **WHEN** the Settings modal is open over a view and the user dismisses it
- **THEN** the modal SHALL close
- **AND** the underlying view SHALL become interactive again with its scroll position unchanged
