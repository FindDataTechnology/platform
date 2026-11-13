# Proposal: add-fleet-board

## Why

萬星独立运行 program 切片④：机群观测有了数据面（fd-wanxing fleet-observer 的
`/api/fleet/v1/board`，切片③），但没有面向人的视图——这正是"在哪看到所有萬星部署的
agents"的产品答案。按 program 决策（Q2），渲染宿主是 ops-console，数据源改为萬星观测
API，不再各自直连轮询。

## What Changes

- ops-console 新增 `fleetBoard` 数据源：`FLEET_BOARD_URL`/`FLEET_BOARD_TOKEN` 轮询
  observer 的 board（沿用 poller 注册表与降级渲染纪律：未配置=明示 not configured，
  失败=stale/failed，绝不静默省略区块）。
- `renderFleet` 前置「机群总览」块：五态分布、agents 总数、per-runner 水位
  （children/budget/上限/queued）、唤醒延迟 p50/p95、24h 回合/错误/budget kill/退温、
  结算 pending、按 source 的摄取滞后（双基）。现有 per-agent 表保留为细节视图
  （runner health 直连退役与否随②切流后再议）。

## Capability Impact

- ADDED `ops-console`：机群总览需求（读萬星观测 API + 指标集 + 降级语义）。

## Non-goals

- observer 本体与其 API（fd-wanxing ③，已有）；部署者产品页（⑤）；
  runner health 直连的移除（兼容期保留）。

## 验收口径

- 未配 FLEET_BOARD_URL：总览块显示 not configured，其余板面不受影响。
- 配置后：总览块指标齐（上列全集），observer 停答时显示 stale/failed 不消块。
