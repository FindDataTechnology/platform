# 设计 — add-platform-guaranteed-capture

## D1 tap 接缝定案（勘定 2026-11-07，全部单点）

1. **chat**：`server/dsh-events.js:215` `ctx.finishTurn` 定义体（`recordPackUsage` 旁）+ `server/runtime-bindings.js:190` 包装层（`originalFinishTurn` 透传语义天然兼容——tap 放定义体一处即可覆盖双载体？**否**：包装层调用 `originalFinishTurn` 后有 `queueMicrotask` 后续动作，证明两个定义都在活路径上；tap 各接一处，共享同一 `observeTurnTap()` 无状态入口，双接不双报由 finishTurn 的「per-turn 幂等（无 open turn 即 no-op）」天然保证——只有真正关闭回合的载体走到 tap）。
2. **bot**：`server/bots.js` `handleMessage`（539 起）——`dshBridge.prompt` await + `collected` 结算的 try/finally（711 起），成功/失败/中止三分支统一在 finally 前取 outcome 上报；被回复门禁扣住的回合 outcome 照实（门禁在投递层，回合本身已完成）。
3. **智语**：`gateway/zhiyu/room-router.js:131` 起的回合函数——返回值 `'answered'|'passed'|'failed'` 就是 outcome，`callAgent` 返回后、settleTurn 旁一处上报；`passed`（分身主动「过」）也落底（过程叙事）。

## D2 捕获件形状（server/observe-tap.js，单文件薄封装）

```js
observeTurnTap({ ownerEmail, lane, sessionId, agentId, outcome, durationMs,
                 title, body, roomId? })  // 全部 fire-and-forget，永不 throw
```
- 内部：`cellMemoryConfig(env)` + `personTokenFor`（磁盘缓存复用）→ SDK `observeFireAndForget({url, token, event})`；`CELL_MEMORY_OBSERVE_TAP=0` 或 owner 缺失或配置不全 → 直接 return（零请求）。
- 事件体：`{type:"turn_outcome", idempotency_key: newIdempotencyKey(), title, body, harness:"yizuo", subject: agentId, metadata:{lane, sessionId, agentId, outcome, durationMs, ...(roomId?{roomId}:{})}}`。
- 房间态：`project` 用房间名（`clusterProjectId(roomId)` 同构规则）经 SDK observe 客户端的 project 参数落房主根房间 project——SDK observe.ts 若无 project 参数，则 0.1.3 补一个可选参（fd-memory /observe 落 project 由令牌 namespace 决定，person 令牌写非 default project 走既有 /pages 的 project 语义核对后再定；若 /observe 不支持 project 指定，房间 tap 改走 /pages POST（observation 页型）保持平台担保语义等价——任务 1 先做该核对）。
- 截断纪律：title=入站消息前 80 字符（chat=用户 prompt、bot=入站 text、智语=触发消息）；body=final text 摘要 ≤4000 字符（复用 runner `compactJsonText` 同级纪律）；永不落工具输出与原始事件。

## D3 令牌与归属

- chat/bot：owner person 令牌（u/<email>）→ default project。
- 智语：房主 person 令牌 → 房间 project（非 default）——与「私人记忆不进空间」互为镜像：房间内容不进任何私人 default 根，成员个人根零写入。
- 铸造失败：tap 静默丢弃 + 计数（`console.warn` 一行，同舰队捕获 fail-open 契约）。

## D4 测试策略

- 每面一条形状断言：真起 cell/网关测试态 → 完成回合 → 断言 /observe 收到事件（mock fd-memory 端点收包，字段逐项断言）。
- finishTurn 双载体幂等：同一回合两次关闭路径只报一条。
- 回滚杆：`CELL_MEMORY_OBSERVE_TAP=0` 三面零请求。
- failure-isolation：fd-memory 5xx/超时 → 回合照常、无重试。
- room 隐私：成员个人根零写入断言。
- 既有套件回归：dsh-profile-memory/cluster-memory/cell-memory 四重指向件 + zhiyu-room 既有套件。

## D5 风险与非目标

- 风险：finishTurn 热路径多一次出站调用——fire-and-forget 无 await + SDK 有界超时（2s）+ 失败即丢，最坏情形一条 warn；高并发 bot 场景的令牌桶限流（fd-memory 逐令牌护栏 120/min）可能丢事件——丢的是过程叙事非功能，可观测计数可见，不加剧。
- 非目标：线程 B（记忆可感 UX）/C（状态层合一）；舰队五类事实捕获改造；读面注入语义变更；智语成员级私人捕获（隐私反向，永不做）。
