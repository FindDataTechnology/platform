# polish-desktop-fleet-parity — A 系（公司式舰队）桌面收尾与种子舰队

## Why

「A/B 两系都做」拍板（2026-10-28 D1）后，A 系的盘点结论是**基本已成立**：`fleets`/`boards`/`cron` 路由逐行查过、对桌面零门控，车队 UI（驾驶舱、ops canvas、模板向导）随同一份 web 构建物发出，托盘/管家常驻保证关窗后定时回合继续跑。剩下的是收尾三件：**首启没有任何本地舰队的上手段**（从装好到「一支跑起来的舰队」全靠用户自己摸）、**种子模板只有市场一条供给道**（离线机器拿不到）、**桌面差异点无人普查**（单用户身份、cron 时区、引导与驻留互斥等）。本 change 把 A 系在 Win/Mac 上的终点线画齐，并让 B 系（`add-local-fleet-control-plane`）的本地集群与 A 系在同一台机器上互为样例。

## What Changes

- **首启「跑起第一支舰队」引导步（新）**：`onboarding-guidance` 的首启 tour 增一步（桌面壳内触发、可跳过、可重开）：串珠「装官方入门样例 pack → 用模板向导实例化 → 跑一轮 → 产出进 boards」。每一步失败逐项降级（沿用实例化器既有降级语义），不阻塞应用启动。
- **种子模板随包预置（新）**：官方入门样例 pack（含一支 3-4 岗位的 fleet 模板 + 入门技能）由 `add-offline-pack-supply` 的 `resources/bundles/` 烘焙管线带入安装包；cell 首启把预置 bundles 登记为**可导入源**（不自动安装——安装仍是显式动作/引导步内确认）。
- **离线模板可用性**：模板以 pack 形态经市场分发之外，SHALL 支持来自离线 bundle 的模板参与实例化（与市场模板同一条实例化器路径与降级规则）。
- **桌面差异点普查与修复（spike 先行）**：列清单核对（单用户身份 owner 语义、cron 时区与停机补跑、无登录跳转、窗口驻留与引导交互、boards 空态）；逐项修或立账，结论进 design 补记。
- **双平台见证**：乘在途 `automate-nonweb-acceptance` installer-e2e 轨加一幕「装 → 首启引导 → 样例舰队跑一轮 → boards 见产出」，windows 默认腿 + mac dispatch 腿。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `onboarding-guidance`: 首启 tour 增「跑起第一支舰队」步骤（桌面壳内、可跳过、可重开、失败逐项降级）。
- `agent-fleet-templates`: 「模板以 pack 形态经市场分发」扩出离线 bundle 供给道（同一实例化器与降级规则）；「官方种子库守恒」扩出「种子随安装包预置、首启登记为可导入源但不自动安装」。

## Impact

- **代码**：`bootstrap/first-run.js`（登记预置 bundles 为导入源）、`web/src`（首启引导步 + 空态引导；复用 `FleetTemplateWizard` 与 `PackDetailDialog` 的既有件）、`server/routes/pack-templates / agent-fleet-templates` 相关读面（离线模板来源标记）。
- **契约**：新增「预置 bundle 导入源」读面与引导步骤标记；既有三步骤 tour 与市场模板路径向后兼容（无预置包时渲染旧流程）。
- **依赖**：消费 `add-offline-pack-supply`（bundle 格式与烘焙管线）与 `add-local-fleet-control-plane`（本地部署读面）；两者未落地时以仓库内置样例包走引导（降级到市场可取则联网取）。
- **风险**：首启引导与桌面驻留窗口的交互（引导在窗口内，关窗即驻留）——spike 需实操核对一次。
