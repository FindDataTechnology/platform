# Proposal: add-fleet-cockpit-projection

## Why

舰队机制在萬星侧的下一步挂账（decision-lane D6）：把壹座已活体的**舰队驾驶舱循环**镜像到萬星控制台。①四天自然 cadence 观察（2026-10-23→27）已证明被投影的读面本身是活体的（CEO 68 轮巡逻/防洪闸生效/72h 过期生效/平台滚版被舰队上报）。

传输管道已建成且在生产跑：paas gateway 的 cell-sampler（`gateway/fleet-cells.js`）每 30s 经身份信道（`x-forwarded-email` + `CELL_GATEWAY_SECRET`）采样活 cell 的 `/api/tasks/stats`，以 `cell_stats` 事件单向上报萬星 fleet-observer `/ingest`（生产 env 已配 `FLEET_INGEST_URL/TOKEN`），OpsView「短期执行」段已渲染。Explore 报告 `docs/explore-wanxing-cockpit-projection.md` 三向比完：**A1 事件流延伸**（零新凭据、只读容错）优于拉取代理（新攻击面）与拍板同形生产者（双向写缝，留后续独立 change）。

## What Changes

- **paas**：新 cell 内聚合端点 `GET /api/fleets/overview`——一次调用回该 cell 全部舰队的 compact 投影（health chips + 待拍板数/top3 题面/各岗最新报数一行），payload 有界（题面≤80字、摘要≤120字、各岗指标≤4 槽、decisions top3、payload 版本号 v:1）；cell-sampler 扩展——同身份信道每 tick 采样 overview 并以新事件品种 `cell_fleets` 上报（独立采样间隔 env，默认 60s）。
- **fd-wanxing**：`cell_fleets` 品种在 EVENT_KINDS 枚举白名单注册（ingest 对未知 kind 400）；新读端点 `GET /api/fleet/v1/cell-fleets`（raw kind 窗合成「每 cell 最新快照」+样龄，绝龄→stale 呈现，ops token gate 与 board 同构）；OpsView 新增「壹座舰队镜像」段——每舰一卡（名/状态/健康/待拍板 N 件+top3/各岗 latest 一行/样龄）+深链回 paas `/fleets/:id`（动作一律回壹座，投影只读）。
- **不做**：不动 mission 状态机/拍板 API/事项面板；不做双向写回；不做实时拉取；不做 deployer 个人视角（v1 受众=ops 面）。

## Capabilities

### New Capabilities

- `agent-fleet-cockpit-projection`: 舰队驾驶舱循环向萬星运营面的只读镜像——壹座侧 compact 投影端点 + 采样上报，萬星侧品种注册 + 合成读点 + OpsView 镜像段。

### Modified Capabilities

（无）

## Impact

- 代码：`server/routes/fleets.js`（overview 端点）、`gateway/fleet-cells.js`（sampling 扩展）；fd-wanxing `services/fleet-observer/{store,observer}.js`、`wanxing-web/src/views/console/OpsView.jsx`。
- 出片：镜像 platform（汇器）+ wanxing-observer（商店/API）+ wanxing-web/facade（UI）——三镜像 GitOps 双端。
- 兼容：paas 新端点为纯新增路由；萬星新品种为白名单追加；OpsView 新增段缺席降级（observer 未升级时面板段隐去，与「短期执行」段同律）。
