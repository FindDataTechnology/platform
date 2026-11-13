# fix-fleet-round-discipline Design

## Context

三条缺陷的机制已在探索阶段钉到具体代码行（证据日期 2026-10-25，生产 9 连败实证）：

**A — 忙谓词盲区**。交付控制器（`server/dsh-mcp-delivery.js`）的排空机制本身完整
（250ms poller、硬顶、`drainIfIdle` 重查、cron 回合 pre-round 排空钩子
`ctx.drainDeferredCredentialRestart` 已在 `runCronJobTurn` 顶部接线）。缺口只在接线处：

```js
// server.js:734-738
const credentialDelivery = createCredentialDelivery({
  isStreaming: () => Boolean(ctx.isStreaming),   // 只看 web 活回合
  restart: ({ mcpPatchPath }) => ctx.dshBridge.restart({ mcpPatchPath }),
});
```

共享子进程上的非 web 回合经 `collectTurn` 收集器注册：cron 与 bot-relay 注册在
`ctx.sessionCollectors`（cron-runner.js:49 默认参、bots.js:359），委托回合注册在
`ctx.taskTurnRegistry`（delegation-aggregator.js:144）。这些回合对上述谓词不可见。
另外 `dshUpdateMcp` 末端「hot-swap 关闭 / 空 patch」兜底走裸 `ctx.dshBridge.restart`
（server.js，"Fallback: hot-swap disabled or no servers" 分支），绕过控制器。

**硬顶算术陷阱**：`DEFAULT_MAX_DEFERRED_MS = 5min`（dsh-mcp-delivery.js:23），而
cron 回合默认预算 10min（cron-runner.js:683）。即使谓词修好，回合第 0 分钟到来的
凭据变更会在第 5 分钟被 poller 强推——缺陷原样复发。

**B/C — 同一原语缺失**。任务创建时一次性铸造 `sessionId: cron-<id>`（cron.js:299）
且永不更换（fleet-reconcile.js 注释明文 "the task id (and its bound session) never
changes on cadence edits or swaps"）。dsh 子进程按 id 从磁盘续命对话状态
（server.js 注释 "dsh persists sessions by id so the conversation resumes from
disk"）→ 每回合把全部历史灌回上下文。swap 清史调 `chatHistory.deleteSession`：
dsh 侧 `session/delete` 在 0.0.1-rc.1 无此 RPC 时被吞（dsh-bridge.js:358-370、
chat-history.js:439-447），宿主 unlink 只覆盖遗留 JSONL（"under dsh the live
session file is null"），SQLite 镜像清了但子进程那份活着；下一回合同 id `prompt`
原样续上。**结论：不修 `session/delete` 的支持度，改用不依赖它的原语。**

## Goals / Non-Goals

Goals:
- A：共享子进程上的任何在途回合都不被凭据/兜底 restart 打断；硬顶 ≥ 回合预算。
- B：舰队成员回合逐回合全新子进程对话；镜像单会话稳定累积可读；磁盘与上下文双有界。
- C：swap 清史的可验证语义（下一回合必不回放旧史）+ 钉住它的单测。

Non-Goals:
- 不给 dsh 补 `session/delete` RPC 或任何 dsh 协议改动（版本依赖是 C 的成因，不是解法）。
- 不动普通定时任务的「绑定会话续执行」语义（频率低、用户可能依赖延续性；本 change 不扩大战场）。
- 不动 worker 槽位（各自独立 bridge，主子进程 restart 天然不影响）。
- 不动 a2a/tool 岗位（不碰主子进程；a2a 镜像累积是读成本不是 token 成本）。
- 噪音 D（幻觉工具名、冷启动首轮）不单独立项——A/B 上产后预期大幅缓解。

## Decisions

### D1 — A 的忙谓词：注入处扩为「共享子进程忙」，控制器本体不动形状

`server.js:735` 的谓词改为：

```js
isStreaming: () =>
  Boolean(ctx.isStreaming) ||
  (ctx.taskTurnRegistry?.size ?? 0) > 0 ||
  (ctx.sessionCollectors?.size ?? 0) > 0,
```

- 两个注册表 OR：`taskTurnRegistry` 覆盖 cron + 委托，`sessionCollectors` 覆盖 cron +
  bot-relay；并集即共享子进程上全部非 web 在途回合。控制器（含 poller、硬顶、重试、
  `drainIfIdle` 重查语义）零改动——它本来就是对的，错的只是喂给它的信号。
- 备选「在控制器里注入两个谓词」被否：语义上这是「运行时忙」一个信号，拆两个参数只会让
  排空重查逻辑变复杂；备选「给每个回合 lane 加显式计数器」被否：注册表已存在且
  settle 路径保证增删配对（cron-runner.js:55-63），再造计数器引入新的配对风险。
- worker 槽位验证过不注册在这两张表上（worker-slots.js 用 worker 本地 map + 独立
  bridge），谓词正确地不覆盖它们。

### D2 — A 的硬顶：提到 15min，并留「从回合预算推导」的接缝

`maxDeferredMs` 传入 `15 * 60 * 1000`（≥ 默认回合预算 10min + 余量）。排空收敛性：
推迟的 restart 在回合终止后由三重路径兜住——poller（谓词转闲即执行）、下一回合
pre-round 排空、`drainIfIdle` 的忙重查保证不与新一轮抢跑。若未来回合预算可配置超过
15min，接缝是从任务 timeout 推导，本 change 不做（当前预算硬编码 10min）。

### D3 — A 的兜底路径：全部 restart 收进控制器

`dshUpdateMcp` 末端「hot-swap 关闭 / 空 patch」兜底的裸 `ctx.dshBridge.restart` 改走
控制器（新增一个非凭据标签入口或复用 `onCredentialChange` 加 label 参数——实现取简，
spec 只约束「经由控制器」）。preset 切换触发的 restart 不在管辖内：它只发生在回合
pre-round（switchPresetForJob 在回合开始前、已等 idle），不在途回合可打断。

### D4 — B/C 的核心原语：子进程对话 id 按回合轮换，镜像 id 稳定

persona 执行路径（`runPersonaTurn`）改为：

- 子进程对话 id = `` `${job.sessionId || `cron-${job.id}`}#r${startedAt}` ``（回合开始
  时间戳，`runCronJobTurn` 已算好）。**不用持久化计数器**：引擎按任务串行出队，
  同任务同毫秒双触发不存在；时间戳免持久化、免重启回卷、免迁移。
- `collectTurn` 增可选 `mirrorSessionId`：收集器键 = 子进程 id（通知按 prompt 的
  sessionId 路由，收集键必须等于 prompt 键——这是轮换必须带收集键一起换的原因），
  `recordMessage`/`setTitle` 落镜像用稳定 id。改动一个小参数，其余镜像逻辑不动。
- cluster 成员子会话：`memberSessionId` 前缀用本回合子进程 id，镜像仍落任务稳定 id。
- **约束确认**：轮换不依赖任何 dsh RPC 支持——子进程见到的永远是新 id，无从续命；
  这正是它比「修好删除」可靠的原因（C 的教训内化）。

### D5 — B 的回收：回合收尾 dispose，一轮滞后无栈

回合收尾（collectTurn settle 后、子进程转闲）对本回合子进程 id 发 best-effort
`deleteSession`。失败仅记警告：轮换已保证旧 id 永不再续命，回收只影响磁盘。
宿主重启丢失内存里的 last-id 只造成个别孤儿漏收，磁盘增量按回合频率有界
（约 0.5MB/回合级），可接受；不做按前缀扫描等重型 GC。

### D6 — C 的 swap：清史语义改挂轮换原语

swap 的 `freshSession` 分支保留 `chatHistory.deleteSession`（镜像清空重建），效果契约
改为由轮换保证：清史后下一回合的子进程 id 必然全新（D4），与 `session/delete` 是否
被支持无关。备选「deleteSession 失败改为 swap 报错」被否：把可自愈的磁盘问题升级成
用户可见失败，且仍不能验证子进程状态（无读回 RPC）。

### D7 — 判定「舰队成员回合」的口径：sourceTag.fleetId

轮换与 dispose 挂 `job.sourceTag?.fleetId` 判定（fleet-reconcile 物化时写入，
routes/fleets.js:147 既有形状），不加新字段。委托/事件唤醒与节奏同缝
（runCronJobTurn），天然同待遇。

## Risks / Trade-offs

- [镜像与子进程转写的 id 映射断裂——用户在镜像里看到的旧回合无法在子进程侧回放]
  → 子进程侧转写本来就不对用户开放（读路径全走 SQLite 镜像）；镜像全量可读不受影响。
- [收集器键假设被既有代码隐含依赖] → `collectTurn` 的通知路由按 prompt 键分发是既有
  事实（本次只是显式化）；tasks 里安排核对 cron-runner/bots/delegation 的既有单测。
- [#r<timestamp> 后缀泄漏到日志/UI 的可读性] → 子进程 id 不出现在 UI；日志里带后缀
  反而便于追踪单回合。title/镜像 id 不变。
- [硬顶 15min 内子进程持续忙（连续回合背靠背）使凭据交付延迟到排空窗口] → 下一回合
  pre-round 排空保证在下一回合消费工具前交付；凭据是下一次工具调用才消费的，等待无
  正确性代价（提案原论）。
- [swap 清史后旧子进程文件成为孤儿] → 与 D5 同回收路径：该任务下一回合收尾按内存
  last-id 兜不住 swap 前的 id 时，漏收个别文件，磁盘有界，可接受。

## Migration Plan

一班上产（A/B/C 同仓同面，无跨服务依赖）；无数据迁移——现存 2.3MB 级会话因轮换自动
断粮，旧镜像行与子进程文件按既有 GC 节奏自然淘汰。回滚 = 回滚镜像即可，轮换无持久化
状态（时间戳派生），无单向前置。

## Open Questions

（无——三个决策点均有实证支撑，无需要用户裁决的分歧。）
