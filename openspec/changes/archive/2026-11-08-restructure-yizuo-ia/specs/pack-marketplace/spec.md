## MODIFIED Requirements

### Requirement: The 壹座 Store tab carries a market guide entry

On the 壹座 pack market surface — the market tab of the 智能体市场 surface at `/agents?tab=market`, the product's single in-product pack doorway; `/packs` redirects into this same tab so an old bookmark lands on the same facet line and is never left with a context-free dock — the copilot dock SHALL resolve the facet line's focused assistant (existing `GET /api/boards/facet/copilot` resolution, no new endpoint) and open the guide with that preset injected — same open/restore semantics as the board path. While the guide is open, the surface SHALL publish the currently inspected pack (from the detail dialog's lifecycle) into the guide's context bar via the existing same-origin postMessage channel; the injection SHALL be read-only (the embed registers no page-action handler, and any write intent SHALL still travel through the action gate's propose path). The dock SHALL follow the surface across its tabs, and SHALL keep working on pack detail dialogs opened from either of the surface's two tabs (`market` and `mine`): the same focused-assistant resolution, the same inspected-pack publication, and the same read-only injection SHALL hold on both, because a pack detail dialog can be opened from a listed pack and from an installed snapshot alike. When the facet assistant pack is not installed (no resolvable focused preset), the surface SHALL surface an honest hint pointing at the assistant's market entry instead of an unfocused guide pretending to be gated. The facet standalone site (anonymous surface) carries no guide entry in this scope.

#### Scenario: opening the guide from the Market tab injects the focused preset

- **WHEN** a signed-in user on `/agents?tab=market` opens the copilot dock and the 谦面助手 pack is installed
- **THEN** the guide session runs under the `facet-assistant` focused preset and the context bar names it

#### Scenario: the inspected pack reaches the guide's context

- **WHEN** the pack detail dialog is open and the user asks the guide a question
- **THEN** the guide's context bar shows the current pack and the answer may reference it

#### Scenario: the dock follows the surface to the mine tab

- **WHEN** the user opens a pack detail dialog from the installed snapshots under `/agents?tab=mine` and asks the guide a question
- **THEN** the guide's context bar shows that inspected pack, and the injection stays read-only exactly as on the market tab

#### Scenario: write intent stays gated

- **WHEN** the user asks the guide to subscribe to the inspected pack
- **THEN** the turn surfaces an action proposal card (propose/confirm/audit), never a direct subscription

#### Scenario: honest degradation without the assistant pack

- **WHEN** the 谦面助手 pack is not installed on the cell
- **THEN** the Market tab shows the guidance hint toward the assistant's market entry and the guide does not claim a focused preset

#### Scenario: the standalone site carries no guide

- **WHEN** an anonymous visitor browses the facet standalone site
- **THEN** no guide entry appears (the anonymous-surface guide is out of scope)

### Requirement: 市场面只在网关前置部署出现

市场界面（浏览、详情、订阅、我的包、创作/发布）SHALL 只在部署报告 `packMarketplace` 为真的形态下可达；`/api/config` 报告 `packMarketplace: false` 时，判据 SHALL 作用在智能体市场面（`/agents`）的 `market` tab 上，而不是整页：该 tab SHALL 缺席，`mine` tab SHALL 照常渲染（已装快照与创作草稿都是本地状态），市场面 SHALL NOT 以空壳形式留在原地。`/packs` 及其深链（`?tab=`、`?deployCastPack=`）SHALL 重定向到 `/agents` 的对应 tab，并保留这两类参数（分面工坊的部署交接 `deployCastPack=` 是契约，不得被静默丢弃）；市场 tab 因判据缺席时，重定向 SHALL 落到该面的首个可见 tab（`mine`），既有链接 SHALL NOT 以死链收场。

判据 SHALL 在市场面自己的路由/页面里执行，而不是依赖某个上层容器是否挂载它——挂载点
会随信息架构搬迁（agents 中心页已于 2026-11-06 拆解，`/packs` 于 2026-11-07 以独立
路由恢复，2026-11-08 又并回 `/agents` 的 `market` tab），而这条边界不该随挂载点搬家丢失。
判据所用的配置 SHALL 在首绘前已就绪，避免首次渲染时把网关前置部署误判为本地部署。

非市场面不受此限：已装包管理与创作草稿（更新/卸载、草稿/发布入口）属于本地状态与运行域，
两个部署形态都 SHALL 保留，因此 `mine` tab 在两种形态下都 SHALL 可渲染。

#### Scenario: 本地部署访问市场深链

- **WHEN** `/api/config` 报告 `packMarketplace: false`，用户访问 `/packs?tab=market`
- **THEN** 应用重定向到 `/agents` 并激活首个可见 tab（`mine`）
- **AND** 市场面（`packs-page`、市场页签、市场卡片）不出现
- **AND** 已装快照与创作草稿仍可在此面管理，链接不以死链收场

#### Scenario: 网关前置部署行为不变

- **WHEN** `/api/config` 报告 `packMarketplace: true`，用户访问 `/packs`
- **THEN** 重定向到 `/agents?tab=market`，市场面正常渲染，页签与市场列表可用

#### Scenario: 部署交接参数随重定向保留

- **WHEN** `/api/config` 报告 `packMarketplace: true`，用户访问 `/packs?deployCastPack=<packId>`
- **THEN** 重定向后的地址仍携带 `deployCastPack=<packId>`，分面工坊的部署交接照旧完成
