# Proposal: fix-llm-breaker-streak

## Why

10-27 落地的车道熔断（滑动窗：10 分钟内 5 次开 10 分钟冷却）对**无人值守舰队结构性无效**——回合 cadence 最小错峰 15 分钟、典型小时级：窗内攒不满阈值，攒满了也没有下一回合落进 10 分钟冷却期。

实弹证据（fd-wire 递送 `docs/fd-wire-model-upstream-resilience-evidence.md` + 2026-11-04 定谳）：
- 10-28→11-04 上游 5xx 风暴 94 条 `model_upstream` 失败，任意 10 分钟窗最大 5 条（仅 10-30T23:38 一次踩到阈值）；
- pod 内探针证实车道指纹解析正常（deepseek-v4.1-flash → `lane-01eb3e096d91165c`，buildLaneLookup 接线活着）、记账代码在跑——**零 skipped 是滑窗语义够不着，不是接线死代码**；
- 「避免每轮撞墙」（`paas-fleet-turn-reliability-requirements.md` §四需求原句=「连续失败达阈值」）落空，撞墙照常每轮发生。

## What Changes

- 熔断计数从**挂钟滑动窗**改为**连续失败 streak**：该车道每次 model_upstream 失败 +1（与间隔无关）；车道上任一成功立即清零并关窗。阈值默认 5 不变（`PLATFORM_LLM_BREAKER_THRESHOLD` 可配）。
- 冷却期默认 10 分钟 → **2 小时**（`PLATFORM_LLM_BREAKER_OPEN_MS` 可配），覆盖典型小时级 cadence。冷却期满后的第一个回合=半开探针：成功→清零关窗；再败→ streak 仍在阈值之上，立即再开——持续故障期浪费的撞墙次数从「每回合」收敛到「每冷却窗一次」。
- `PLATFORM_LLM_BREAKER_WINDOW_MS` 随滑窗废止移除（生产从未配置该 env，无迁移负担）。
- 不变：总闸 `PLATFORM_LLM_BREAKER=0`、车道键控与退化特例、skipped 回合形态（agent-fleet-core）、短窗降级重试与 `degradedTo`（其链长门槛如实性另见 design 记录）、明文密钥不落日志。

## Capabilities

### Modified Capabilities
- `cron-module`：「模型车道按身份键控熔断与降级重试」熔断段改 streak 语义 + 冷却默认 2h。

## Impact

- 代码：`server/llm-lane.js`（状态机：failures[]/sweep → streak 计数）、`server/cron-runner.js`（skip 文案计数名）。
- 测试：`scripts/test-fleet-turn-attribution.mjs`（熔断断言组改 streak；新增「间隔不敏感」场景）。
- 消费方：`breakerState().failures` → `.streak`——全仓仅 cron-runner 一处 skip 文案 + 测试消费，管理面展示不变（读 openUntil/streak 字段）。
- 出片滚产：同面 gateway 镜像；上产后验收=下一个上游 5xx 窗口内出现 skipped 行（无窗则 e2e 红绿 + 状态机单测双证收口，沿 fix-fleet-model-drift 5.2 先例）。
