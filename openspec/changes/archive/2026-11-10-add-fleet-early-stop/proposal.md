# Proposal — add-fleet-early-stop

## Why

今天（2026-11-09）产线仍有 12 条 `turn timed out — context pressure`。看那批的压缩次数：**12、13、14、15 次**——它们在第 6 次压缩时就已经注定跑不完，却继续占着 cell 唯一的一条串行槽直到 600 秒。

代价不只是自己的预算：`oldestQueuedMs` 实测到过 **17–25 分钟**，同 cell 的其他舰队回合都在排队。也就是说，一个注定失败的回合，用 10 分钟挡住了整条队列。

## What Changes

- collector 在舰队回合里统计压缩次数；达**硬阈值 4 次**且已运行 ≥60 秒时，**原生取消**该回合（`dshBridge.cancelSession`，与人工停止同一条 API），并以 `context pressure` 收口——随后走**同一条**收尾补数车道。初稿写的是 6 次，实测下调：5 次压缩的回合同样烧满 600 秒且无可恢复产出。
- 只在**舰队回合**启用（`earlyStop` 由 `sourceTag.fleetId` 决定）；人类会话与普通定时任务保留完整预算。
- `FLEET_EARLY_STOP=0` 可整条关闭。

## Impact

- Affected specs: `cron-module`（回合预算条款 + 3 场景）
- Affected code: `server/cron-runner.js`（`collectTurn` 的压缩计数处、常量与开关）
- 无迁移、无新 env（开关缺省即启用）；人类车道零变化。
- **最坏情况与现状等价**：取消后仍是「压力失败」，只是把 600 秒提前到 60–90 秒。
