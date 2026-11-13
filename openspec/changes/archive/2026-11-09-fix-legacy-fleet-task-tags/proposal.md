# Proposal — fix-legacy-fleet-task-tags

## Why

测试中抓到一条 600 秒、6 次压缩、`detail` 为 `"null"` 的失败回合，追下去发现根因不在早停逻辑，而在**归属判定**：

产线存在一类**舰队任务没有 `sourceTag`、但 `origin.fleet.fleetId` 有值**的记录（2026-10-24 前后创建）：

```json
"sourceTag": null,
"origin": { "fleet": { "fleetId": "fleet_1792876489464_sfdmnj", "memberId": "...", "depth": 2 } }
```

规模实测：一个 cell 276 条舰队类任务里 **111 条**如此，另一个 66 条里 **42 条**。

而运行时有 **6 处**只读 `sourceTag?.fleetId`：

| 位置 | 后果 |
|---|---|
| `cron-runner.js` `roundChildSessionId` | 不轮转子进程对话 → 历史累积 → 压缩风暴 |
| `cron-runner.js` 就绪门 | 按非舰队任务处理（不做等待宽限） |
| `cron-runner.js` earlyStop | 不提前停 |
| `cron-runner.js` isFleet ×2 | 不补报数 |
| `cron.js` `composeFleetPrompt` | **不注入舰队上下文** → 岗位盲跑 |

也就是说这类任务**整条舰队链路都失效**，而症状只表现为「跑了 600 秒、detail 为空」。

## What Changes

- 新增 `fleetTagOf(job)`：从 `sourceTag.fleetId` **或** `origin.fleet.fleetId` 取值（`buildTurnRequest` 的归属早已这样读，本刀让 runner 与之一致）。
- 上述 6 处判定统一改用它。

## Impact

- Affected specs: `cron-module`（舰队回合条款补充双源归属 + 1 场景）
- Affected code: `server/cron-runner.js`（新增 `fleetTagOf`，6 处替换）、`cron.js`（上下文注入门）
- 无迁移、无数据修补：存量任务在下一次触发即自动走对路径。
- 不改变正常任务：现代记录 `sourceTag` 有值，行为不变。
