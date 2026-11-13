## Why

萬星被 CONTEXT.md 定义为「对常驻与短期 agents 的监控与管理」的运行管理层，但现状只有一半：
常驻面（runner 舰队）有完整管理面——registry entry 全维度状态 + fleet board + 心跳自报；短期面
（cell 内 task engine + worker pool）**没有任何跨 cell 可见性**（WS 事件与 /api/cron 都是 cell 内
视角，`dashboard_state` 的 activeTasks 还是恒空占位），fd-prod 的 worker 池甚至显式串行（cap 0）
且无人看见。数百 agents 规模下运营者无法回答「全平台此刻有多少短期执行在跑、排队多深、worker
池饱和没」。本切片同时收口调研底稿悬置的「甲/乙读法」未决问题（萬星管理层边界）。

## What Changes

- **甲/乙定案（决策，非代码）**：管理（控制动作）= 甲读法，只覆盖 runner 舰队——pause/kill/
  budget/rhythm/harness 均为部署面动作，**永远不伸进用户 cell**（ADR-0008：cell 隔离原语是进程
  边界）；监控 = 统一只读——cell 短期执行以**只读遥测**进舰队面，由 gateway 代采上报（cell 不持
  平台凭据、不开任何入站控制通道）。未决 #3 随之定案：短期执行宿**留在 cell**（worker-pool
  现状），不搬 runner。
- **task engine 只读 stats 快照**：`stats()` 派生（调度任务数、按状态的执行数、worker 池
  cap/busy/idle、近期终局计数）——纯计数、**不含 prompt 等用户内容**；cell 暴露
  `GET /api/tasks/stats`（标准 cell 鉴权，非 loopback 豁免）。
- **gateway 代采上报**：新模块周期采样活 cell 的 stats 端点，以 `cell_stats` 事件投递 fleet
  ingest（与 runner 心跳同一 observe 面）；env 驱动 opt-in，**默认关 = 字节级零变化**；尽力而为，
  失败仅记日志、绝不影响 cell 流量。
- **runner 心跳补 pod 密度自报**：runner_stats payload 增 `pod` 布尔（config.podMode 已有、
  任何心跳/表都不含——实证缺口）；缺席降级开放（旧 runner 兼容）。
- **姊妹仓 fd-wanxing**（独立 change，本仓 tasks 仅交叉引用）：observer EVENT_KINDS 白名单收
  `cell_stats`、board 增 cells 段（窗口内每 cell 最新遥测 + 汇总）、良机 console 统一视图渲染。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `task-engine`: 新增要求——任务引擎暴露只读 stats 快照（纯计数、无用户内容、含 worker 池占用）。
- `cell-gateway`: 新增要求——cell 任务遥测经 gateway 只读代采进舰队面（opt-in、默认关、无控制
  回程、不影响 cell 流量）。
- `harness-adapter`: 「Harness selection is declared per deployment and gated at deploy time」
  要求扩一心跳场景——runner_stats 携带 pod 密度自报，缺席降级开放。

## Impact

- 代码：`task-engine.js`（stats 派生 + 导出）、`server/routes/tasks.js`（新 stats 路由）、
  `server/worker-slots.js`（pool 占用 getter）、`gateway/fleet-cells.js`（新：代采上报器）+
  `gateway/index.js` 接线、`agent-runner/fleet.js`（payload 增 pod）。
- 部署：fd-prod 平台容器（gateway+cell）与 agent-runner-serving 共用同一镜像，一次出片两处
  滚动；新增 env（FLEET_INGEST_URL/TOKEN、采样间隔）默认不配即关。
- 姊妹仓 fd-wanxing：fleet-observer（EVENT_KINDS/board cells 段）+ wanxing-web console 统一
  视图——各自独立 change 与发布线。
- 无 breaking：全部新增面 opt-in 或降级开放；既有端点/事件形状不变。
