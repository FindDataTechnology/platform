# Proposal — fix-dispatch-delivery

## Why

派发任务的 `initiator` 取的是 **运行时的全局会话指针**
（`server/routes/fleets.js:1117` `initiator: chatHistory.currentSessionId()`，
其实现是 `chatHistory.js:330` → `ctx.dshSessionId`）。

派发归因（`resolveAttribution`, `server/fleet-reports.js:115`）本来已经**知道**调用从哪来，
三个分支分得很清楚：

| 归因分支 | 实际情况 | 应该的 initiator |
|---|---|---|
| `turn`（恰有一条在飞舰队回合） | 定时车道 | 该回合的镜像会话 `turn.sessionId` |
| `job-sourceTag` / `cluster-task` | 运行中的舰队任务 | 该任务的 `task.sessionId` |
| `preset` | 聊天车道 | 当前会话指针（现状正确） |

但紧接着创建任务时，三个分支被压成一个 `chatHistory.currentSessionId()`。定时回合运行期间
这个指针**碰巧**指向绑定的会话（所以没炸），但它只是一个全局指针：只要同时有聊天回合在跑，
或者回合收尾后指针被别的会话占住，派发回执就会被聚合器投递到**别的对话**里——而规格写的是
「目标岗回合摘要经聚合器在**派发岗**下一回合注入」。

顺带两个同源缺口（与 `fix-fanout-aggregation` 同族）：

- 派发任务**不记录 initiator 人格** → 回执汇总由运行时最后组合的人格来说（就是扇出那个 D1 的翻版）。
- 派发任务**没有聚合分组键** → 同一派发岗的多次派发会并成一次汇总。

## What Changes

- `initiator` 改为按归因分支取值：在飞回合 → 回合镜像会话；运行中任务 → 任务会话；
  聊天车道 → 现状（全局指针）。
- 派发任务补 `initiatorPreset`：定时/任务车道取派发岗的 roster 预设，聊天车道取当前人格。
- 派发任务补 `initiatorGroup`（`dispatch:<base36 时间>:<随机>`），一次派发一组。
- 聊天车道的行为保持不变（有测试钉住）。

## Impact

- Affected specs: `agent-fleet-orchestration`（dispatch 边 requirement 修订）
- Affected code: `server/routes/fleets.js`（dispatch 创建点一处），依赖既有
  `initiatorGroup` 字段（`fix-fanout-aggregation` 已落）与既有 `reanchorInitiatorPersona`。
- 无迁移、无新表；缺人格的旧任务仍走 `reanchor` 的空值早退 = 旧行为。
