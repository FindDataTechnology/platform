## Why

市场面的动线是「逛 → 认 → 装 → 用了没 → 该不该更新」。`unify-material-market` 把五个页签收敛好了，但**买家在这一面上看不出自己和这件素材的关系**：

- `web/src/components/packs/PackCard.tsx` 只出官方/采纳/类型三类徽章（`pack-official-badge-*`、`pack-adopted-badge-*`、`pack-type-badge-*`），**没有「已装 vN」也没有「可更新 vY」**。已装的东西在市场上看起来和没装的一模一样，用户只能切到「我的」逐个核对。
- 市场页自己手搓了页签条与页头（`web/src/pages/AgentMarketPage.tsx:118-141`，`border-b-2` 活动态），没过 `Tabs`/`PageShell`。design-lint 的 side-tab 规则只查左右不查上下，所以它是绿的——但 `DESIGN.md:356` 是同一条禁令，且这个条子丢了 foundation 的键盘合同（箭头/Home/End/roving tabindex）。
- 顺带记录一个本批 e2e 抓到的既有缺陷：谦面 market 面上的副驾丢了线路上下文（`CopilotDock` 只认 `tab === "market"`，而市场页会把 slug 归一成 `agents` 并回写 URL）。修在 `unify-line-board-tabs` 6.1，本 change 只登记归属、不重复修。

这一版不改门、不改 slug（五个 `?tab=` 是公开契约），只让这一面把「你和它的关系」和「键盘可用」补齐。

## What Changes

- **卡片带关系状态**：市场卡片在 `已装` 时显示「已装 vN」，在线上有更新版本时显示「可更新 vY」，两者都用 `StatusPill` 词汇；状态来自已装快照与目录版本对比，缺任一侧就不显示（不猜）。
- **状态进入卡片而非新页签**：不开第六个页签、不改 `agents/market` 别名规则、不动 testid 契约。
- **页签条与页头收编 foundation**：`/agents` 的页头改用 `PageShell`，页签条改用 `Tabs`（保留 `agent-market-tab-<slug>` 的 testid 与既有键盘行为），活动态不再用 `border-b-2`；design-lint 基线不涨。
- **空态与失败态回落 StatesKit**：市场面在无目录、目录失败、搜索无结果三种情况下分别给出 `EmptyState`/`ErrorState`，保持列表形状（不空屏）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `agent-catalog`: 市场卡片 SHALL 呈现已装版本与可更新状态（缺数据时不显示），且页签条与页头遵循 foundation 的键盘/语义契约；页签集合、slug、testid 契约不变。

## Impact

- `web/src/components/packs/PackCard.tsx`（关系状态徽章）
- `web/src/components/packs/PackMarketView.tsx`（把已装快照喂给卡片；三态回落）
- `web/src/pages/AgentMarketPage.tsx`（页头 → `PageShell`，页签条 → `Tabs`）
- `web/src/lib/packs-api.ts` 或既有已装读取钩子（状态来源，若需一次合并读）
- locales 五语（已装/可更新/三种空态）
- e2e：`e2e/ia-doorways.spec.js`、`e2e/agents-tabs.spec.js`、`e2e/packs.spec.js` 保持绿 + 新增卡片状态断言
- **不动**：五个页签的 slug 与顺序、`agent-market-page`/`agent-market-tab-*`/`agent-market-panel-*` testid、市场后端与目录 API 形状、`/agents` 路由
