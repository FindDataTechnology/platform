# harden-cell-execution-reliability

## Why

壹座执行层（cell/harness/任务引擎）2026-11-06 深度摸底确认三处可靠性裸奔点与两处测试洞。执行层是壹座「多端 agents 执行平台」定位的底座：一次长停机窗外故障=静默丢轮、一次 loopback 挂死=无自愈，对非技术用户都是「平台悄悄坏了」。用户拍板（2026-11-06）：这一版做到能做到的最好，执行层可靠性硬化列入收口战役 P1。

摸底证据（全部 file:line 实证，2026-11-06）：

1. **任务失败即终态、无通用重试**：`task-engine.js:619` 失败即 `failed` 终态；唯一自动重试是 cron-runner 的一跳快速失败重试（`server/cron-runner.js:828-837`，60s 窗）；cron 补跑只保容差窗内一枪（2×周期、地板 6h，`cron.js:173-198`，kill switch `PLATFORM_CRON_CATCHUP=0`）。**窗外停机+故障组合=静默丢轮**（只记账不补跑）。
2. **41 处 `await fetch` 无超时**：gateway/server 合计（grep 实证），含登录路径微信 code2Session（`gateway/mp-auth.js:114`）与 MCP bridge 家族约 10 处（`server/fleet-mcp.js:173,199,228,315` 等）——loopback 自调用挂死时无自愈。
3. **零测试核心模块**：`server/cron-runner.js`（1452 行最大执行体，无同名直接测试）、`gateway/index.js`（1181 行装配面，装配本身无测）、`gateway/cell-report.js`（201 行）、`agent-runner/harness/acp.js`（第二 harness，adapter 测试偏 dsh）。
4. **写放大隐患（低优先，现量级无碍）**：duty-ring 每 60s 对每个 suspended cell 全量 put（`duty-ring.js:43-47`）与 jobs.json 全量重写（34KB/次）。
5. **账本缺口**：cheap-7 迁机磁盘事故（2026-11-05，PV 钉死→Pending 死锁→三跳 SSH 清镜像复活）与 cheap-3 DiskPressure 复发（2026-11-06，facet 驱逐 502 一刻钟）在 CONTEXT/INFRA-NOTES 零记录。

## What Changes

- **任务级重试策略（代码+spec）**：task-engine 失败终态引入可配置策略重试（指数退避、上限次数、每任务类可覆盖；默认保守=不改变现网行为，开启走 env）。cron 补跑窗外丢轮从「只记账」升级为「记账+显式告警事件」（复用既有 alerting 通道，wire-metering-explicit-alerting 先例）。
- **fetch 超时纪律（代码+spec）**：新增共享 fetch 包装（默认超时+可覆盖），mp-auth 登录路径与 MCP bridge 家族 41 处全部接入；超时即结构化失败（可重试类/不可重试类区分）。
- **核心模块测试补齐（测试+spec）**：cron-runner（1452 行）契约测试（状态迁移/重试/补跑判定纯函数化抽测）、gateway/index.js 装配冒烟（openapi paths 断言形态）、cell-report.js、acp.js 至少 adapter 契约各一。
- **运维账本回填（文档）**：CONTEXT.md/INFRA-NOTES 补 cheap-7 事故与 cheap-3 DiskPressure 复发记录（判据/修法/预防），DiskPressure 复发根因调查单独立项不在本单。
- **明确不做**：duty-ring 写放大（现量级无碍，挂观察）；分布式锁（单写者架构是设计选择）；cron 补跑窗扩宽（产品语义另议）；DAG wave2。

## Capabilities

### New Capabilities

（无——全部并入既有 capabilities）

### Modified Capabilities

- `task-engine`：失败处理从「终态等人」扩为「策略重试+告警」，补窗外丢轮告警 Requirement。
- `cron-module`：补跑口径补「窗外停机丢轮必须显式告警」Requirement（现 spec 只写窗内补跑）。
- `harness-adapter`：补「第二 harness（ACP）契约测试在位」Requirement（防 adapter 单腿演化）。
