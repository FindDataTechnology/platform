# Proposal: add-trial-window-adaptive

## Why

蓝图试跑的收证窗口是 10 分钟硬编码（`runTrial` timeoutMs 默认），而 cell 的执行主链是**全舰队共享的串行队列**——繁忙 cell 上队列延迟实测 ~16 分钟（走查 cell 226+ jobs 常年深队，2026-11-01 三连红定量化）。试跑成员的回合**必然**迟到：fireRound 点火后任务在深队排队，窗口先关，`lib-report` 断言结构性判红——km 3.3 端到端绿被此卡住（§15.121 续六/七）。静窗在常年繁忙的走查 cell 不存在，等待不是解法。

## What Changes

- 试跑收证窗口**对在途回合自适应顺延**：轮询期间若被点火岗位的任务仍在 `queued`/`running`（在 fleet 的串行链上排队或执行中），deadline 按 poll 步进顺延——回合还没得到它的执行机会，超时判红就是误判。
- **绝对封顶**：自适应总窗不超过 `2 × timeoutMs`（20 分钟）——顺延有界，卡死任务不会把 trial 挂成无限等。
- **如实留痕**：发生顺延时证据面携带 `windowExtendedMs`（顺延总量），报告可查。
- 语义不变式：回合真正执行后（无论 ok/failed）即停止顺延——车道失败的回合照常以既有失败证据落红（熔断/503 的真相不被窗口掩盖）。

## Capabilities

### Modified

- `fleet-blueprint-studio` — 试跑验收能力内 **ADDED Requirement**「试跑收证窗口对在途回合自适应」（在途回合顺延 / 绝对封顶 / 如实留痕 / 执行后即停四场景）；既有试跑验收需求块不动。
