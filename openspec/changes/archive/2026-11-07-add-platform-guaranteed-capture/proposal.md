# Proposal: add-platform-guaranteed-capture

## Why

永忆完整解决方案落地后，壹座作为旗舰客户的写路径仍半靠自觉：舰队/集群回合有平台侧五类事实捕获（`fleet-memory`/`fleet-turn-memory`），但 **chat、智语房间、bot 三面的回合记忆完全依赖纪律文本恳求 agent 调 `memory_write_page`**——记不记得住取决于模型心情，这与永忆「平台担保捕获」的承诺（`yongyi-observe-lane` 已在 fd-memory 落地 `/observe`）在旗舰客户这里断开。fd-memory 的 `/observe` 面与 SDK observe 客户端（fire-and-forget、幂等键、失败即丢）均已现成，壹座只差把每回合的收尾接缝接上——勘定已毕：三个面的回合收尾都是单点接缝，tap 成本极低。

## What Changes

- **新增平台侧回合捕获 tap（三面，全部 fire-and-forget）**：每回合收尾向 fd-memory `/observe` 上报一条 `turn_outcome` L0 observation，落 owner（u/<email>）根，metadata 携带 `{harness:"yizuo", lane, sessionId, agentId, outcome, durationMs}`：
  1. **chat（web UI 全部回合）**：tap 打在 `ctx.finishTurn`（`server/dsh-events.js` 定义、`server/runtime-bindings.js` 包装——双载体处都接，包装层天然透传 outcome）
  2. **bot（WeCom/Feishu/Telegram/公众号）**：tap 打在 `server/bots.js` 的 `handleMessage` 回合收尾（`dshBridge.prompt` await + `collected` 结算处，含失败/中止分支）
  3. **智语房间（分身/值守分身/嘉宾触发）**：tap 打在 `gateway/zhiyu/room-router.js` 的三分支结算点（`answered`/`passed`/`failed`——round-router 回合函数的返回值即 outcome）
- **捕获件**：新增 `server/observe-tap.js` 薄封装——SDK `observeFireAndForget` + `newIdempotencyKey` + owner person 令牌复用（`personTokenFor` 磁盘缓存），env 开关 `CELL_MEMORY_OBSERVE_TAP`（缺省开，`0` 全关回滚杆），正文字段做截断纪律（用户消息前 N 字符为 title，final text 摘要为 body，不拖全 transcript）
- **纪律文本降位**：`MEMORY_DISCIPLINE` 中「会话收尾调 memory_handoff_begin」条款保留（handoff 是 L1 观点层，平台 tap 不可替代），但记忆成立不再依赖它——tap 保证每回合至少一条 L0 落底
- **Non-goals**：线程 B（记忆可感 UX）与线程 C（状态层合一）另立 change；舰队/集群既有五类事实捕获不动（已是平台侧）；不改变 chat-memory 注入阶梯的读面语义

## Capabilities

### New Capabilities

- `platform-turn-capture`: chat/bot/智语三面的回合收尾平台担保捕获——tap 接缝（finishTurn 双载体 + bots 回合结算 + room-router 三分支）、身份归属（owner person 令牌）、metadata 一等字段、fire-and-forget 降级契约（捕获失败零影响回合）、回滚杆、正文截断纪律

### Modified Capabilities

- `chat-memory`: Purpose 与纪律描述更新——「用户明示记住时写 note」从记忆成立的前提降位为 L1 观点层补充（平台 tap 已担保 L0 底座）；读面注入需求零变化
- `zhiyu-room`（若其 spec 含回合记忆语义则对齐一行，无则不列）：房间回合的产出经捕获落 owner 根

## Impact

- 代码：`server/dsh-events.js`、`server/runtime-bindings.js`（finishTurn 双载体各 +1 处 fire-and-forget 调用）；`server/bots.js`（handleMessage 收尾 +1）；`gateway/zhiyu/room-router.js`（三分支结算 +1 处）；新增 `server/observe-tap.js`；`docs/` 纪律文本来源不动（SDK 单源）
- 依赖：零新增——SDK observe 客户端已在 `@finddatatechnology/yongyi-client@^0.1.2`
- 风险：finishTurn 每回合多一次出站 fetch（fire-and-forget 不 await、有界超时，SDK 已钉契约）；owner 令牌铸造失败时 tap 静默丢弃（与舰队捕获 fail-open 同契）
- 测试：每面一个 tap 断言（回合结束 → /observe 收到正确形状事件），回滚杆测试，failure-isolation 测试
