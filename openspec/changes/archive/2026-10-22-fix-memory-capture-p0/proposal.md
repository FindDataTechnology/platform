## Why

舰队记忆 v1 上产后新确认两处 P0（ADR-0030 D6，`docs/memory-architecture-v2.md` §2）：① `agent-runner/memory-capture.js` 只有一个 `#namespace`（38 行），`observe()` 每次覆盖、`flush()` 把整队事件打到最后那个 namespace（63 行）——生产 runner 托管多个部署，A 的观测排队后 B 一 observe，A 的事件就落进 B 的 namespace，是跨部署乃至跨 owner 的错投通道；② `manager.js:946` 代采的观测 summary 只有 `"${kind} turn ${outcome} tokens=N (Nms)"`，设计本意（v1 design D6）的工具调用摘要没落地——L0 没有内容，后续任何蒸馏引擎接上都是空转。两处都在作用域改造与引擎接入之前必须先修，否则 L0 一旦丰富，错投就从「无害」变成泄漏。

## What Changes

- **capture 批次按 namespace 归队**：观测事件自带 namespace，flush 按 namespace 分组投递（或每 namespace 一队）；混合 namespace 批次永不串投，以突变测试钉死（同 manager 两个部署交替 observe 后各自 namespace 只含自己的事件）。
- **观测带内容**：manager 从 dsh 事件流（`dsh-events` 已有 tool/result 双形状解析）与 ACP 回合缝组装 `turn_start | tool_call | tool_result | turn_end` 事件，携带 `tool_name`、参数摘要、结果摘要、用户意图摘要（各自截断上限进 `AGENT_RUNNER_MEMORY_*` env）；摘要在 runner 侧截断、在 fd-memory 侧过既有四类脱敏。fd-memory capture API **不改**——结构化摘要序列化进既有 `summary` + `tool_name` 字段。
- **纪律文案只在挂载在场时注入**：`#spawnPod` 今天注入「已挂载 fd-memory，请调 memory_handoff_begin」却没挂工具；改为纪律文案与挂载同生同灭（pod 的挂载本身由 `add-memory-scopes-and-cluster-sharing` 承运，本 change 只消除自相矛盾）。
- **cell 纪律接上消费者**：`cell-memory.js` 返回的 `discipline` 在 `dsh-profile.js:968-969` 无人消费；接到 cell persona。
- **明确不做**：namespace 形状、令牌族、pod 挂载、agentId 派生（都在姊妹 change `add-memory-scopes-and-cluster-sharing`，因为牵涉数据迁移）；fd-memory 服务端任何改动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runner`: 「部署 agent 的工作记忆经平台缝代采与挂载」——观测内容从回合结果扩展为工具调用/结果/意图摘要；观测必须落在产生它的部署的 namespace（跨部署批次不串投）；persona 记忆纪律文案仅在该运行时组合实际携带记忆挂载时注入。
- `memory-federation`: 「cell 记忆挂载遵守组合与凭据纪律」——cell 挂载在场时 persona 同样携带记忆纪律文案（与舰队部署同一文案单源）。

## Impact

- 代码：`agent-runner/memory-capture.js`（分组队列）、`agent-runner/manager.js`（`#memoryObserve` 改为事件级代采，接 dsh-events / ACP 回合缝）、`agent-runner/compose.js` / `compose-acp.js`（纪律文案条件化）、`dsh-profile.js`（cell 纪律）、`agent-runner/config.js`（摘要截断 env）；测试：`memory.test` 增串投突变测试 + 观测形状测试。
- 服务与部署：fd-memory 零改动；滚 `runner-serving`（platform 镜像）与 cell 镜像；回滚 = `AGENT_RUNNER_MEMORY_ENABLED=0`（既有杆）。
- 数据：观测体积上升（每回合从 1 条变为 1+2N 条），fd-memory PVC 5Gi 需观察；无迁移。
- 顺序：本 change 先于 `add-memory-scopes-and-cluster-sharing` 滚产；两者的 `agent-runner` delta 均为同一需求的 MODIFIED，后者归档时以前者归档后的主 spec 为基线重写。
