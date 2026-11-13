# Design — fix-dispatch-delivery

## D1 initiator 从归因结果里读，不再读全局指针

`resolveAttribution` 的三个分支已经携带了全部必要信息：

```js
// fleet-reports.js:117  —— 恰一条在飞回合
return { kind: "turn", fleetId, memberId, turn };
// :127-131  —— 运行中的舰队任务
return { kind, fleetId, memberId, task };
// :139  —— 聊天车道
return { kind: "preset", fleetId, memberId, member };
```

`turn` 是 `fleet-runs.js` 的回合句柄，其 `sessionId` 字段就是**镜像会话**
（`fleet-runs.js:143` `sessionId: mirror`，`mirror = job?.sessionId`）；`task` 的
`sessionId` 是任务自己的专属会话。两者都是"回执该回到哪里"的准确答案。

因此：

```js
const initiator =
  (attribution.kind === "turn" ? attribution.turn?.sessionId : null) ??
  (attribution.kind === "job-sourceTag" || attribution.kind === "cluster-task" ? attribution.task?.sessionId : null) ??
  chatHistory.currentSessionId();
```

最后那个 `??` 保留聊天车道原语义，也是"归因说 turn 但句柄没会话"时的诚实兜底——
`??` 链只会在两个精确答案都缺时才落到指针上。

**为什么不改 `chatHistory.currentSessionId()` 本身**：它是**全局单指针**，承载
"UI 现在在看哪个会话"的语义（`chat-history.js:321,434,468` 的读面都靠它）。
让它变成"当前回合的会话"会把两件不同的事混成一个字段，且影响所有既有调用点。
问题在**调用方**用错了来源，不在指针本身。

## D2 与 fix-fanout-aggregation 同形：人格 + 分组键

- `initiatorPreset`：非聊天车道取 `rosterPresetId(from.targetId)`（该岗回合实际所用的人格）；
  聊天车道取 `ctx.currentPreset`。聚合器 `reanchorInitiatorPersona` 对**活着的会话**是幂等
  早退（`preparedPreset === wanted` → 不发 park），所以聊天车道传人格不会产生任何额外动作。
- `initiatorGroup`：`dispatch:<base36>:<rand>`，一次派发一组。没有它，同一派发岗的多次派发
  会被聚合器按 session 并成一组——而每次派发都有自己的 brief 与目标，应当各自回执。

## R1–R4

- **R1 聊天车道回归**：现有测试断言 `task.initiator === "sess-sup"`（聊天车道）。
  该用例的归因走 `preset` 分支（无在飞回合、无运行任务），所以 `??` 链落到指针 → 值不变。
  另加断言 `initiatorPreset === ctx.currentPreset`。
- **R2 多条在飞回合 / 归因歧义**：`resolveAttribution` 在这些情况下返回 `none`/`ambiguous`
  并已 409 拒绝，走不到创建点；不改。
- **R3 重复投递**：分组键让每次派发独立，聚合器 `pendingInjection` 按键去重；一次派发仍只汇总一次。
- **R4 tool 岗**：tool 目标的 prompt 仍是 JSON 参数；`initiator`/`initiatorPreset`/键都是任务元数据，
  不进 prompt——既有"逐字节相同"断言继续成立（本次已复跑）。
