# Design — fix-stale-drop-respects-period

## Context

动机与代价数字见 proposal.md。本文件只记判据怎么算、以及为什么不是"改上限"或"改文案"。

现状（读码）：

| 事实 | 位置 |
|---|---|
| 丢弃判据只看等待时长，不看周期 | `task-engine.js` 的 `dropIfStaleQueued`：`t.trigger !== "schedule" \|\| t.queuedBy === "human"` 即豁免，然后是纯年龄比较 |
| 两处生效：出队时与周期清扫 | 同函数被出队路径与 `sweepStaleQueuedFires` 共用，所以改一处即两处生效 |
| 丢弃即终局 | `finishExecution(t, ..., { skipped: true })`，不补跑、不计 `missed`，下一次排期才重来 |
| 周期字段已存在 | `task-engine.js` 的 `t.interval`（unit/number/anchor），与 `clientShape` 一同序列化 |
| 产线上限 | `QUEUE_MAX_AGE_MS=600000`（`fd-infra-deploy/all-services/prod/platform.yaml`） |

## Goals / Non-Goals

**Goals**

- 让丢弃判据认识"这个任务的下一班多久来"，使丢弃的代价有界。
- 让 error 文案不再对长周期任务说谎。

**Non-Goals**

- 不改 `QUEUE_MAX_AGE_MS` 的默认值或产线取值（那是容量/延迟权衡，不是本 bug）。
- 不改 `queuedBy === "human"` 的豁免（点火的那一轮从不因老化被丢，这是既有正确行为）。
- 不引入补跑机制（那是另一个议题：`missed` 的语义与 catch-up 窗口）。

## Decisions

### D1. 判据用「周期 ≥ 长周期下限」，**不是**「周期 > 陈旧度上限」

第一版实现用的是后者（"丢弃必须有接替者，等价于周期 ≤ 上限"），听起来干净，**但它是空转的**：

产线 `QUEUE_MAX_AGE_MS = 600000`（10 分钟），而任何真实 cadence 都是小时级起步（spec 自述"无人值守回合
cadence 最小错峰 15 分钟、典型小时级"）。于是"周期 > 10 分钟"几乎命中了全部排期任务——**每条都会豁免，
策略表面在跑，实际一条也不丢**。第一版就是这么写完、跑出测试才发现：小时级用例没有按预期被丢弃。

根因是把两个量纲混为一谈：

| 量 | 含义 | 产线取值 |
|---|---|---|
| `QUEUE_MAX_AGE_MS` | 一发火最多等多久（耐心） | 10 分钟 |
| 长周期下限 | 丢一轮最多损失多少（代价） | 6 小时 |

两者不能互推。代价必须有独立阈值。

**替代方案**：把上限调大（如 6 小时）让不等式成立。否决——上限还承担着"让位给新触发"的职责，
调大会直接退回到补跑潮饿死执行槽的老问题上（`fix-cell-turn-throughput` 正是为这个把上限从 30 分钟压到 10 分钟）。

### D1b. 下限默认 6 小时，可配

理由：小时级 cadence 丢一轮只损失 1 小时，且下一次火很快到，可接受；6 小时及以上丢一轮已经吃掉
四分之一个工作日，不可接受。默认值取"包含 6 小时本身"（`>=`），并允许运维用
`QUEUE_STALE_EXEMPT_MIN_PERIOD_MS` 覆盖。

**替代方案**：硬编码"天/周"白名单。否决——会漏掉"每 40 天"这类 cron 五段表达不了的区间单位（本仓已支持），
也漏掉 6h/12h 这类真实存在的中等周期。

### D2. 判不出周期时保持既有行为（丢弃），不放宽

数据不全时收紧方向应当偏向"不改变现状"。若反过来（判不出就豁免），一个字段缺失就会让队列里堆满永不丢弃的过龄轮，等于把有界策略静默关掉——这是更坏的失败模式。

**替代方案**：判不出周期也豁免。否决，理由同上。

### D3. 文案与处置一致，而不是统一文案

现有文案断言"由下一次排期接替"。对豁免的那批这正是**不能**说的话。让文案跟着分支走，比统一成模糊表述更好：读日志的人能直接看出这一轮是丢了还是留着。

### D4. 落点是同一个函数，不是新加一层过滤

`dropIfStaleQueued` 同时服务出队与清扫两条路径。在函数内加周期判定，两条路径自动一致；若在调用处各加一次，将来很容易只改一条（本仓已有这类前例）。

## Risks / Trade-offs

- **[风险] 豁免会把 `queueHealth().degraded` 顶成 true，进而让 `/readyz` 常亮 503** —— 这是本单最尖锐的一条，链条已核实：
  ```
  degraded = stalled || overBudget > 0 || orphaned > 0
  stalled  = oldestQueuedMs > QUEUE_MAX_OLDEST_QUEUED_MS && !settledRecently
  ```
  被豁免的长周期轮会一直留在 `queued`，`oldestQueuedMs` 持续累积 → `queuedTooLong` 恒真。
  只要该 cell 还有别的回合在settle，`settledRecently` 为真、`stalled` 为假，没事。
  **但一旦它是队列里最后一条、且 cell 再没有回合收口**（豁免期间正好空闲），
  `settledRecently` 在 10 分钟后转假 → `stalled` 为真 → `degraded` → cell 侧 `/api/ready` 503
  → 网关 `/readyz` 聚合出 `degradedCells` → 200 变 503。**一条在等槽的日更轮，能把整个平台标成未就绪。**

  → 缓解（纳入实施要求）：**被豁免的轮 SHALL NOT 参与 `oldestQueuedMs` 的取最大**，或等价的显式豁免——
  即"永不丢弃"的任务不能同时充当"队列卡住"的证据。宁可让健康指标看不见它，
  也不能让它把一个健康但空闲的 cell 判成 stalled。
- **[风险] 被豁免的长周期轮长期占位，看起来像积压** → 缓解：豁免只影响"是否丢弃"，不占用槽位；观测面按上一条处理后，`oldestQueuedMs` 反映的仍只是可丢弃的那批。
- **[风险] 日更轮被豁免后仍要等槽，可能等到下一班才跑（跑了也是过期的）** → 缓解：这是取舍的另一半。至少它跑过；若将来要区分"过期但仍有意义"，那是内容层判断，不属于队列策略。
- **[风险] 与 `fix-operator-ignition-priority` 同时上线时，队列瞬时深度上升** → 缓解：两单的建议上线顺序是**先本单、再开点火开关**，观察一轮 `oldestQueuedMs` 与 `skipped` 计数后再决定。

## Migration Plan

- 无数据迁移、无部署顺序硬要求；但建议顺序：本 change 出片 → 观察一个日更周期 → 再设 `QUEUE_HUMAN_PRIORITY=1`。
- 回滚：反向改判据即可（无状态、无迁移）；`QUEUE_MAX_AGE_MS=0` 是最快的应急总闸。

## Open Questions

- **`interval` 单位表的第二份副本**：`cron.js` 定义 `UNIT_MS`（minute/hour/day/week），`task-engine.js` 里为
  `schedulePeriodMs` 复制了一份同名表 `INTERVAL_UNIT_MS`——引擎不能反向依赖调度前端，所以这份副本是有意的。
  当前安全（`cron.js` 的 `validateInterval` 只放行这四个单位），但**没有机制保证两处同步**：若将来加入
  `month` 之类的新单位，引擎侧会把它判成 `null` → 走「判不出即丢弃」的老规则 → 月更任务又会被整轮丢掉，
  也就是本 change 要修的那个 bug 在新单位上复现。缓解办法有两个，择一即可：把单位表提到共享模块
  （`lib/` 下），或在 `cron.js` 扩展单位时同步改 `task-engine.js` 并在 `validateInterval` 加一条断言。
  不阻塞本 change。
- **点火是否应获得额外槽**（与 `fix-operator-ignition-priority` 共用同一裁决）：现状授予「否」，本 change 不改变它。
