## Why

人的点火（`run now` / owner 的 `execute now`）在**两套执行路径**下的优先级语义是分裂的，而正式 spec 断言它已被保证：

`openspec/specs/worker-pool/spec.md` 写着「人的唤醒的**排队优先级**不属于本规则——它由主槽串行链按 `task-engine` 的执行槽排序自行保证（越过未开始的排队执行），与池是否启用无关」。

这句话在池激活时**不成立**：池激活（`TASK_WORKER_MAX > 0`）后，派发器直接 `beginExecution` 认领排队任务，**从不进入串行链**（`server/worker-slots.js` 自述如此）。于是三方互相指认——spec 说串行链保证、串行链说池不归它管、池只按 FIFO 认领——谁都没做。

实测代价（2026-11-09）：`hotel-watch-scout` 以 `queuedBy=human` 在队列里等了 20 分钟，而它的 `nextRun` 已经是第二天。它被**礼貌地饿死**：老化不丢它、顶替不动它、又抢不到槽，系统认为自己「正确地没丢它」。

**同一天深挖之后发现这不是"排序不公"，是死锁**（2026-11-09 23:35 实测，cell `3fdc7b8e8ac03b68`）：

```
queued 3 条，全部等待 56–57 分钟：
job_1792876490012_ygkf05   intel-poster  queuedBy=human    nextRun 次日 00:10Z
job_1792885292645_v3q0yz   zx-patrol     queuedBy=human    nextRun 当日 23:50Z
task_1794234897853_ovd0h8  law-chief     queuedBy=cadence  nextRun None（manual，无排期）

同期占着全池 cap=3 的 persona：intel-patrol / intel-chief / user-preset-2 —— 与上面三个**零重叠**
```

三条因果叠加成一个自咬的环：

1. worker 与 persona 绑定、cap 是全池共享 → 等待中的三个岗位**既不能复用也不能新开**；
2. `queuedBy === "human"` **豁免老化丢弃** → 它永远不会被 `skipped`；
3. 于是点火轮**既不能丢、也跑不了**，占着队列等 57 分钟，跨过自己下一次触发仍未执行。

第三条 `ovd0h8` 更麻烦：`nextRun = None`（manual 任务没有下一次），一旦被丢就是永久丢失，它只能无限期挂着。

**结论**：排序开关（`QUEUE_HUMAN_PRIORITY`）对这个 case **无效**——问题不在次序，在"没有可派的槽"。真正的死锁成因是"豁免老化"与"抢不到槽"这两条规则各自正确、叠加起来把任务钉住。

同时，新增的池侧排序策略（`be6c0318b`）**没有带任何 spec 增量**，所以正式 spec 至今仍留着上面那句不成立的断言。

## What Changes

- **修正 spec 断言**：删除「排队优先级由串行链自行保证」，改为「池激活时由池的派发器保证」，并明确上限为 0（串行模式）时仍按 `task-engine` 的既有排序。
- **把「排序不是容量」写进规范**：人的点火的排队次序 SHALL 可越过未开始的排队执行；但该次序 SHALL NOT 扩大并发容量——保留的额外槽仍只属于人的**唤醒**（`humanPriority`），不属于 `run now` 打在既有 cadence 任务上的情形（`queuedBy`）。
- **把两个标记的区别写成需求**：`queuedBy === "human"`（requestor，决定排序与老化豁免）与 `humanPriority`（capacity grant，决定额外槽）是两件事，SHALL NOT 互相替代。
- **给老化豁免加一个前提**：豁免 SHALL 以「该轮仍有机会执行」为前提。一条点火轮的等待超过老化上限的 N 倍（N 待定，建议 3）仍未被派发时，系统 SHALL 如实降级——要么允许它按普通轮被 `skipped` 并由下一次排期接替（有 `nextRun` 的），要么把它标为 `stalled` 让运维可见（无 `nextRun` 的 manual 轮）。**MUST NOT 无限期保持"不丢也不跑"的状态。**
- **开关的缺省行为写清**：`QUEUE_HUMAN_PRIORITY` 缺省关闭时，池的派发次序 SHALL 与变更前逐字节一致。

**BREAKING**：无。缺省行为不变（开关默认关闭），只是把已存在的语义写进 spec。

## Capabilities

### New Capabilities

（无——这是既有行为与既有 spec 的对齐，不引入新能力。）

### Modified Capabilities

- `worker-pool`: 「人的唤醒在人满时仍有通道」这条需求里关于**排队优先级归属**的断言不成立（它把责任推给串行链，而池路径绕开串行链）。改为由池的派发器保证，并补「排序不扩大容量」与「两个标记不可互替」两条约束。

## Impact

- **代码**：`server/worker-slots.js`（派发器，已实现，本次不改逻辑）；`task-engine.js` 的 `runTaskNow` / `enqueueExecution`（标记来源，只读引用）。
- **测试**：`scripts/test-worker-pool.mjs` 已新增三条用例钉住两半语义（顺序 / 默认关闭 / 不扩容量），本 change 保留它们为验收依据。
- **文档**：`.env.example`、`DEPLOY.md` 已登记 `QUEUE_HUMAN_PRIORITY` 与 `WORKER_POOL_DEBUG`（本次之前零记载）。
- **不改变**：串行模式（cap 0）的行为、额外槽的归属、任何生产调度顺序（开关缺省关闭）。
- **待裁决**：`run now` 打在既有 cadence 任务上时，是否也应获得额外槽。本 change 按「不授予」写（与现状一致）；若裁决为「授予」，需另开 change 扩容量语义。
