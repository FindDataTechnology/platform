# add-facet-copilot

## Why

谦面双面对新访客有认知门槛（facet 是什么/选哪个 pack/权限意味着什么/怎么装），今天全靠页面自解释。壹座已有完整副驾栈：CopilotDock（FAB+iframe `/chat?embed=copilot`，同源隔离）、动作闸（写工具不进副驾面）、按线聚焦预设解析（`lib/copilot-presets.js` 形状判定 + 官方「谦面助手」pack）。本 change 把这套现成栈带到谦面语境：市场页内出现向导入口，复用聚焦预设与动作闸，零新基建、零跨域。

## What Changes

- **壹座 Market tab 挂向导**：Agents 页 Market tab（`PackMarketView` 宿主）路由上下文下，CopilotDock 的 board 上下文从 `/boards/:line` 扩展为 `/agents?tab=market` 时携带 `line=facet`——打开副驾即注入「谦面助手」聚焦预设（复用 `GET /api/boards/facet/copilot` 现有解析，无新端点）。
- **上下文注入**：dock 开启期间监听市场 tab 的当前 pack 详情（`PackDetailDialog` 打开/关闭事件），经既有 same-origin postMessage 通道注入 iframe 上下文条（当前 pack 名/id），助手首答即可引用。一期只读：助手不操作页面，写动作仍全走动作闸。
- **官方谦面助手 pack 强化**：现有「谦面助手」pack（agent id `facet-assistant`）的技能/prompt 面向四类向导问题打磨：facet 概念讲解、按需求推荐 pack、工具面权限解释、安装引导（壹座一键订阅 + CLI 两条路径）。v2 发布走市场侧动作。
- **匿名访客出圈**：独立站匿名向导（IP 限流免费车道 vs 登录才见）是计费面决策，本 change 不做——一期只在壹座 Market tab（用户已登录）出现向导入口。
- **失败即隐藏**：`COPILOT_ENABLED=0` 或无聚焦助手（谦面助手 pack 未安装）时入口按现有降级语义处理（dock 全局 FAB 已有 kill switch；Market tab 内文案引导去安装助手 pack）。

### 不做

- facet 独立站（匿名面）的向导——计费决策后置另立；
- 跨域嵌萬星 `#/embed`——壹座同源 dock 已覆盖，无需跨域方案；
- 新后端端点、新计费面、frontend action（AI 直接操作页面）。

## Capabilities

### New Capabilities

（无——全部是既有能力（copilot dock、line-boards 预设解析、action-gate）在谦面语境的接线。）

### Modified Capabilities

- `pack-marketplace`: ADDED「The 壹座 Store tab carries a market guide entry」——Market tab 的向导入口、聚焦预设注入、pack 上下文注入与只读边界、无助手时诚实降级。

## Impact

- `web/src/components/CopilotDock.tsx`（route 上下文扩展 facet line）；`web/src/pages/AgentsPage.tsx` / `PackMarketView.tsx`（pack 上下文事件 + 入口引导文案）；`web/src/pages/ChatPage.tsx`（embed 上下文条渲染 pack 上下文，复用现有 board 上下文机制）；`web/src/locales/`（新键五语）。
- `docs/official-packs/facet-assistant`（谦面助手 pack v2：技能与 prompt 面向四类向导问题）；市场侧发布动作（狗粮）。
- 出片：paas 标准线（同 polish-facet-usability，一仓一镜像）。
- 验收：`scripts/test-copilot-presets.mjs` 扩展（market-tab 路由解析 facet）+ `e2e/copilot-dock.spec.js` 扩展（market tab 打开注入聚焦预设、pack 上下文条出现、无助手降级）。
