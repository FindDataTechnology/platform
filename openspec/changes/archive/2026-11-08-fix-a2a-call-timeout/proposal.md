# fix-a2a-call-timeout Proposal

## Why

A2A 客户端 `runA2aTurn` 的 `timeoutMs` 形同虚设，且定时器调错了对象。2026-11-08 本机探针实证
（`docs/multi-agent-collaboration-explore.md` §7.1，探针形态与实测数字在案）：

1. **委托路径的定时器空转。** `server/a2a-client.js:54,75` 唯一的上界是
   `setTimeout(() => signal?.abort(), timeoutMs)`；而委托路径 `runA2aRemoteTurn` 不传 `signal`
   （`server/cron-runner.js:515-522`）→ `?.` 短路 → 定时器什么都不做。实测：`timeoutMs=400`
   的调用在 3009ms 仍未结算。远端半死不活时该回合永远挂着，而回合跑在单条串行执行链上
   （`task-engine.js:616-618`）→ **一个远端能占住整个 cell 的回合槽位**。
2. **传了 signal 反而炸，且有一处无人掩护。** `AbortSignal` 没有 `abort()`（只有 controller 有）。任何传
   signal 的调用方都会在定时器回调里抛未捕获 `TypeError: signal?.abort is not a function`；全仓无
   `uncaughtException` handler（`grep` 零命中）→ 进程退出。两个传 signal 的调用方面临的处境不同：
   - **人聊**（`server/agent-session.js:751-769`，signal + 同刻 300s 双定时器）**靠注册顺序侥幸不炸**：
     调用方 timer 先注册、先 abort、`finally` 清掉内部 timer（实测 416ms 干净 `ABORTED`）。
   - **智语 agent 座席**（`gateway/zhiyu/agent-lane.js:48-62`）传自己的 `controller.signal` 且**从不 abort**
     → 内部 timer 必然到点、必然执行 `signal.abort()` → 任何一次智语 agent 回答超过 300s 即**网关进程退出**。
     这一处没有任何 timer 掩护，是本变更里最该先摘掉的地雷。
3. **规范面从来没有这条要求。** `agent-delegation-a2a` 的现有需求覆盖凭据、远程执行、深度、发现，
   没有任何一条要求「委托调用有时长上界」，所以实现从未被钉过。

Why now：多智能体协同审计把它列为唯一能在本机证死的 P0；A2A 是跨部署协同的唯一车道，
被一个不响应的远端拖住串行槽，代价是整支舰队的回合全部停摆。

## What Changes

- **`runA2aTurn` 内部自持 AbortController**：调用方给 `signal` 时单向联动（caller abort → 内部 abort），
  不给时自建一个；定时器一律调 `controller.abort()`，不再摸 signal。已取消的入参立即失败，不建定时器。
- **超时落结构化、可归因的失败**：到点 abort 后抛带 `timeout` 字样的明确错误
  （`code: a2a_timeout`），由既有 `classifyErrorKind` 归入 `timeout` 类，不新造分类；绝不静默 hang。
  调用方主动取消仍抛 `AbortError`（人聊「用户停 → 静默」语义不变），判别位是内部 `timedOut` 标记。
- **让已下传的回合预算真正生效**：委托路径（`cron-runner.js:515-522`）**本来就把回合预算当下传**
  （`runCronJobTurn` 的 `timeoutMs`），缺陷是这个值从未被当作上界——修的是这层，调用点无需改。
  客户端内建默认值（300s）退回兜底角色：只在调用方既不给 signal 也不给预算时使用。
- **人聊车道收成一条定时器**：`streamA2aChat` 的 300s 与客户端内部的 300s 合为一条（显式下传具名常量），
  消除顺序依赖；300s 到点用户会看到一条超时错误，而非原先的「静默结束」。
- **补三态单测**：不传 signal 超时 → 结构化失败；传 signal 超时 → 结构化失败且无未捕获异常；
  正常响应 → 结果不变。另加一条判别性用例：预算 120s（< 300s 默认）→ 约在 120s 结束。

非破坏性：人聊的 300s 上限不变；委托的成功路径不变；不改 A2A 协议、不改 runner 侧深度界。

## Capabilities

### New Capabilities

（无——缺陷全部落在既有能力的规格增补上。）

### Modified Capabilities

- `agent-delegation-a2a`：新增「委托调用有时长上界」需求——每次出站 A2A 调用 SHALL 受一个
  明确的上界约束，到点 SHALL 以结构化可归因的错误结束该调用（不得静默挂起）；若调用方提供
  取消信号，SHALL 与内部上界联动；上界自身 SHALL NOT 以未捕获异常的形式影响宿主进程。

## Impact

- 代码：`server/a2a-client.js`（内部 controller + timedOut 判别 + 超时错误归类）、
  `server/agent-session.js`（人聊双定时器合一，显式下传 300s）。
  **不改**：`server/cron-runner.js`（预算已下传）、`gateway/zhiyu/agent-lane.js`（传 signal 的形态由 D1 自动免崩）。
- 测试：`scripts/test-a2a-client-timeout.mjs`（新建：三态矩阵 + 预算判别）；既有
  `scripts/test-agent-delegation-a2a.mjs` 六条不动、须继续全绿。
- 依赖/协议：不改 A2A 协议、不改 runner 侧 `delegationDepthMax`、不动 registry 凭据链。
- 行为变化仅限失败面：原先会 hang 的调用改为在预算内失败；原先会炸进程的形态改为结构化失败；
  人聊 300s 到点从「静默结束」变为「一条超时错误」。
- 关联：审计文档 `docs/multi-agent-collaboration-explore.md` §五 P0-2 / §7.1 E1-E3 / §八切片③。
