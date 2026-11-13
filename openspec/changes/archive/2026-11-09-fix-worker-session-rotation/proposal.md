# Proposal — fix-worker-session-rotation

## Why

worker 槽的回合一直用**镜像会话 id**去 prompt 运行时：

```js
const sessionId = task.sessionId;                 // 镜像 id
await worker.bridge.prompt(sessionId, [...]);
```

而主链自 `fix-fleet-round-discipline` 起用的是每轮轮转的子会话 id（`roundChildSessionId`，带 `#r<ts>`）——
因为稳定 id 会把每轮历史累积进同一个会话，直到压缩吃掉整个预算。**pool 路径漏了这一步**。

实测后果两条：

1. worker 上的回合会重读自己累积的历史——正是今晚一直在追的压缩风暴的另一种来源；
2. pool 从 1 提到 3 之后出现 `session "…" is already owned by …`（6 条，**首次 11:48Z**，正是 cap 提到 3 的那个小时），
   因为同一个会话 id 被两处同时持有。

## What Changes

- `runOnWorker` 改用 `roundChildSessionId(task, Date.now(), task.roundSeq ?? 0)` 作 prompt 的会话；
- **镜像 id 保持为转写/侧栏 id**（`chatHistory.recordMessage` 等仍用它），child id 只用于运行时；
- `worker.currentSession` 改为 **child id**——因为 `pumpFor()` 与槽位看门狗都用它查 collector/abort，不改就会静默断开（测试抓到过：回合永不结算）。

## Impact

- Affected specs: `worker-pool`（worker 回合轮转条款 + 2 场景）
- Affected code: `server/worker-slots.js`
- 无迁移；pool=0 时行为不变（worker 不注册）；主链路径不变。
