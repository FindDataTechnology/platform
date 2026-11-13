# Tasks: add-fleet-board

- [x] 1. ops-console：`FLEET_BOARD_URL/TOKEN` env + `pollFleetBoard` 入 SOURCES 注册表
- [x] 2. `renderFleetOverview` 前置机群总览块（五态 pills/agents 总数/per-runner 水位表/
      wake p50p95/24h 回合错误 kill 退温/结算 pending/摄取滞后双基），降级语义与既有板面
      一致（error 快照={__error} 形状，走 failed 分支不落零值渲染）
- [x] 3. 验证（起服三态）：健康=指标全渲染（states pills/runners 行/wake/pending）；
      observer 停答="board read failed … last ok Ns ago" 区块不消失；未配 env=
      "not configured — set FLEET_BOARD_URL/FLEET_BOARD_TOKEN"
