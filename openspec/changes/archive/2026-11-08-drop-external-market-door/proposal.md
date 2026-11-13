## Why

功能集（packs）全部由内部维护，源码就在本仓（`packs/`、`facet/`），当前也没有外部客户。市场面本身已经能在**本进程**挂载：`PACK_MARKETPLACE=1` 时 `server.js` 直接注册 `registerMarketPackRoutes`（见 `server.js` 的 "Pack marketplace MARKET plane" 段），单进程部署不需要另起市场服务。

既然如此，智能体市场页上那枚「打开智能体市场」（指向 `facet.finddatatech.cloud/#/packs`）是**重复门**：它把一个同仓同源的市场说成外部产品，用户点出去看到的是同一份目录，还多一次跨域与一次身份漂移。上一般规格把它写成"唯一的外站门"，前提（外部市场、外部客户）已经不成立。

## What Changes

- 移除智能体市场页的**外站市场入口**（`agent-market-open` 那枚按钮与其 facet `#/packs` 深链）。
- 保留**构建入口**（`agent-market-studio` → facet Studio）：创作面确实在 `facet/web` 的独立部署面上，这是能力边界，不是市场边界。
- 市场 tab 仍是唯一在售面：浏览/订阅/我的包/草稿发布都在 `/agents?tab=market|mine`。

## Capabilities

### Modified Capabilities

- `app-navigation`：把「exactly one pack-market doorway」里的"外加一枚外站市场链接"改为"恰一个在售面，无外站市场门"，构建入口保留并明确其性质。

## Impact

- `web/src/pages/AgentMarketPage.tsx`（删按钮与其 import）
- `e2e/agents-tabs.spec.js`（改断言：不再有 facet `#/packs` 外链；Studio 外链保留）
- 不动：市场后端、`/packs` 重定向、`?deployCastPack=` handoff、Studio 深链契约。
