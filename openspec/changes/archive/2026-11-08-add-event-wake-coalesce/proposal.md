# Proposal — add-event-wake-coalesce

## Why

`event` 边是**逐条唤醒**的：`triggerFleetEventWake` 每收到一条入站消息，就为每个绑定岗建一个
manual 回合。而聊天是连发的——「在吗」+「帮我看下昨天的数」+ 一张图，三秒内到达三个 webhook：

- 三个回合、三份 token、三次付费；
- 被唤醒的岗拿到三段碎片，分三次作答，用户看到三截互不相干的话；
- 频次护栏（每小时 30 次/岗）被这种连发白白吃掉，真正需要唤醒的消息反而被拒。

explore P2-9 记的就是这条：「event 边无去抖（同 bot 连发 N 条 = N 个回合）」。

## What Changes

- 在**入口**加一层合并窗口：以 `(信号源, 会话)` 为键，短窗口内缓冲入站消息（默认 800ms，
  `EVENT_WAKE_COALESCE_MS` 可配，`0` = 关闭）；窗口关闭时把**整段对话**交给既有链路，
  至多建一个回合。
- 合并如实：回合溯源记录承载条数 `coalesced`；正文超长截断并留可见标记；被略去的早期消息
  在正文里显式说明条数；发言人取最后一位发言人；「被点名」= 任一条命中。
- 既有链路（信号策略准入、每小时频次护栏、规则车道、处置记录）**一行不改**——合并发生在
  它们之前，进去的是"一条合并后的消息"。
- 单条消息的溯源与处置行**逐字节不变**（`coalesced` 仅在 >1 时出现）。

## Impact

- Affected specs: `agent-fleet-orchestration`（1 处 MODIFIED：bot 入站唤醒）
- Affected code: `server/fleet-event-wake.js`（窗口 + 合并 + `flushEventWakes` 导出），
  以及两个把"逐条同步创建"当契约的套件改为显式关窗（`test-fleet-turn-mandate`、
  `test-fleet-event-wake`）——它们测的是准入层与形状层，不是合并层。
- 无迁移、无新表；缓冲只在内存，进程退出即丢（窗口极短，见 design R2）。
