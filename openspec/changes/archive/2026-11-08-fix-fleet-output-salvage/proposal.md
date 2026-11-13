# Proposal — fix-fleet-output-salvage

> 原拟名 `fix-fleet-turn-budget` 与 2026-11-08 早先归档的同名 change 相撞；本题实为「点名上下文压力 + 抢救报数」，故改名。

## Why

今晚（2026-11-08）逐 cell 读产线 `member_turn_events` / `trace.db` 得到的事实（explore 新增 P0′ 段）：

- 当天 143 个舰队回合，**82 成功（57%）**；28 条失败全是 `turn_budget_exceeded`，**全部卡在 600s**。
- 这 28 条里 **22 条在该窗口内没有任何报数**（`member_reports` 查无行）——整轮白跑。
- 抽一条 trace：240 个事件跨 535s，**所有 15–49s 的大间隔都落在 `compaction/start|summary|end`**，最后事件停在 `compaction/start`。

也就是说：回合把 10 分钟预算花在**反复压缩上下文**上，到点被砍，产出为零；下一个节奏回合从同一堵墙重新开始。

已排除的假设（都写进了文档）：额度打满（那是昨天的余波，441 条最后在 2026-11-07T22:17Z）、边回合未轮转会话 id（`roundChildSessionId` 生效，trace 落镜像 id，647/805 条任务有 `sourceTag.fleetId`）。**归因：单轮输入超出上下文窗口**。

## What Changes

- **点名原因**：collector 统计本轮 `compaction/start` 次数；达阈值（默认 2）且仍超时时，归因标 `contextPressure: true` + `compactions: N`，错误文案改成
  `turn timed out — context pressure (N compactions)`——不再是一句笼统的超时。
- **补回产出**：对**空产出 + 压力超时 + 舰队任务**的回合，在失败收口后向**同一子会话**追加**一次**收尾询问：只要求调用 `report_status` 交已有结论、明确拒绝其他工具、独立 90 秒预算。
  回合结论**仍是 failed**（它确实没跑完），但 `detail.wrapUp` 如实记录有没有补到内容——舰队不再因为压缩风暴而零数据。
- 收尾**绝不**用于：已有文本产出的回合、非舰队任务、运行时中断的回合、压缩未达阈值的超时（四类各有测试）。

## Impact

- Affected specs: `cron-module`（MODIFIED：舰队成员回合预算 —— 追加压力归因与收尾询问 + 4 个场景）
- Affected code: `server/cron-runner.js`（collector 计数、`timeoutError` 归因、`shouldSalvageReport` 判据、`runWrapUpReport` 收尾车道）
- 无迁移、无新表、无新 env；未触发条件的回合行为逐字节不变。
- **不动的部分**：预算默认仍 10 分钟、压缩策略仍归运行时——本刀只保证「跑不完的回合不再静默丢产出」。
