## 1. 桥层：setPreset 透传 + 世代集合

- [x] 1.1 `dsh-bridge.js` 加 `supportsPresetSet()`（读 `#liveMethods.has("preset/set")`）与 `preparedPreset(sessionId)` 读世代集合；`#preparedPresets` Map 在 `#spawn` 清空、`deleteSession` 删条目。验证：单测覆盖「spawn 清空 / delete 删条目 / 旧 child 返回 false」三态（fake client）
- [x] 1.2 `dsh-bridge.js` 加 `async setPreset({ sessionId, presetId })` 透传 `preset/set` RPC，`#requireReady()` 前置。验证：单测断言 RPC 载荷形状（sessionId/presetId 两键、无多余字段）
- [x] 1.3 被拒分类助手：按「persona is creation-time composition」合同文案识别活会话拒绝（`dsh-runtime-bridge` 既有需求钉死该语义），返回结构化 `{ refused: true }` 与其他错误区分。验证：单测覆盖拒绝文案 / 未知 preset / 传输错误三分类

## 2. 执行器：park 路径 + legacy 回退

- [x] 2.1 `server/cron-runner.js` `runPersonaTurn` 的 preset 段改双路径选路（design D2）：park 路径不取 `reserveRuntime`、prompt 前按 D3 判定顺序驻留；legacy 路径保持 `reserveRuntime("cron-preset-switch")` + `switchPresetForJob` 逐字节等价。验证：`node --test scripts/test-cron-parity.mjs` 全绿（legacy 不回归）
- [x] 2.2 回退三源留痕：`detail.presetPath` 记 `"parked"` / `"legacy:<reason>"`（能力缺失 / 活会话拒绝 / park 硬错），`console.warn` 同步。验证：单测断言三种回退触发源各自产生正确 detail 与 warn
- [x] 2.3 `waitForIdle` 提到双路径共享位置（选路之前），`switchPresetForJob` 内的原 wait 不重复（避免双重等待）。验证：单测断言 park 路径在用户流式回合结束前不 prompt（等待语义保留）
- [x] 2.4 驻留失败时不得留下半注册 collector：park 调用点置于 `collectTurn` 注册之前，回退路径重走既有序。验证：单测模拟 park 抛错后 collector 注册表为空

## 3. 集群扇出与委托聚合

- [x] 3.1 `runClusterTurn` 的 preset 还原段改条件执行：仅当本轮至少一个成员走 legacy 路径才还原；model 还原不变。验证：`node --test scripts/test-cluster-tasks.mjs scripts/test-cluster-platform.mjs` 全绿 + 新用例「全员 parked 时还原步跳过、运行时默认不变」
- [x] 3.2 `server/delegation-aggregator.js` 删去聚合回合前的 `switchPresetTo` 段（design D5），聚合回合经执行器 park。验证：`node --test` 相关委托用例全绿 + 新用例断言聚合回合零重启、`initiatorPreset` 语义不变
- [x] 3.3 fleet 轮换对话 id 的驻留接线确认：park 目标 = `roundChildSessionId` 产物（骑新 id），`disposeRoundChild` 后条目由 1.1 的 delete 钩子清理。验证：`node --test scripts/test-cron-round-rotation.mjs` 全绿 + 新断言每回合 park 调用一次且目标 id 为轮换 id

## 4. 绑定会话任务与跨世代

- [x] 4.1 普通定时任务（绑定会话）按世代驻留：首回合 park、同世代后续跳过、child 重启后重驻留；reconcile 改写任务 preset 后「驻留不同 preset」走 D3 第 3 步。验证：单测覆盖三态（首驻 / 跳过 / 重启后重驻）与换 preset 分支
- [x] 4.2 `job.preset` 为空的 legacy 记录行为确认不变（两路径都不碰 preset）。验证：`node --test scripts/test-cron-catchup.mjs scripts/test-task-engine.mjs` 全绿

## 5. 复核与收口

- [x] 5.1 `ctx.currentPreset` 消费点 grep 复核（proposal Impact 项）：确认定时车道无新增运行时默认消费、聊天车道零触碰；结论写进 change report。验证：`grep -rn "ctx.currentPreset" server/ lib/` 输出逐条注记在 report
- [x] 5.2 全量单测：`node --test scripts/` 相关面（cron/cluster/delegation/task-engine/worker-pool）+ lint。验证：零红
- [x] 5.3 真机验收（按 design Migration Plan）：六人队一轮 spawn 日志零重启、`detail.presetPath` 全 parked、运行时默认前后不变、旧 child 滚版窗内 legacy 留痕可见。验证：验收证据（日志摘录 + 判据逐条）附 change report
