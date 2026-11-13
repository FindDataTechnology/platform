# Design — fix-operator-ignition-priority

## Context

动机见 proposal.md。本文件只记**为什么这样落 spec**，以及实现路径上已经存在的两个事实。

现状（读码）：

| 事实 | 位置 |
|---|---|
| 池派发器直接认领排队任务，不走串行链 | `server/worker-slots.js` 的 `scheduleNext`（注释自述：pool dispatcher claims queued tasks straight into `beginExecution` and never enters the serial chain） |
| 排序策略已实现，开关 `QUEUE_HUMAN_PRIORITY` 缺省关闭 | `server/worker-slots.js` 的 `humanFirstEnabled` |
| 点火来源标记由 `runTaskNow` 打上 | `task-engine.js` 的 `runTaskNow` → `enqueueExecution(id, { by: "human" })` |
| 唤醒标记只由 `createManualTask` 产生 | `task-engine.js` 的 `createManualTask({ humanPriority })` |

## Goals / Non-Goals

**Goals**

- 让 spec 与「池激活时谁保证排序」这个事实一致，消除三方互相指认。
- 把「排序不扩大容量」「两个标记不可互替」写成可测的需求条款。

**Non-Goals**

- 不改派发逻辑本身（已实现，本次只做 spec 对齐与验收锁定）。
- 不改变缺省调度顺序（开关缺省关闭）。
- 不决定「点火是否应获得额外槽」——见 Open Questions，它是产品裁决，不是设计选择。

## Decisions

### D1. 把责任写给「当前生效的路径」，而不是写给串行链

spec 原文把排序责任单方面推给串行链，而池路径绕开串行链。改为：池激活时归池的派发器，cap 0 时归串行链，并显式写明「任何一条路径 SHALL NOT 假定另一条代为保证」。

**替代方案**：把排序责任仍写在串行链，再让池在认领前调用串行链的排序函数。否决——那会把两条路径耦合起来，且池的派发还需要考虑岗位亲和与舰队闸，串行链的排序并不覆盖这些。

### D2. 「排序」与「容量」在 spec 里分成两句话

排序影响的是**谁先**，容量影响的是**能不能同时**。把两者写在同一句里正是这次混乱的来源：`queuedBy=human` 让人以为既然标了"人"，就该享受人的待遇（额外槽），于是把它当成了第二个 `humanPriority`。

**替代方案**：统一成一个「human」谓词（把 `queuedBy` 与 `humanPriority` 合并）。否决——它们是**不同的任务形态**：一个是既有 cadence 任务被点火，一个是新建的一次性唤醒；合并会让「点火是否占额外槽」这个产品问题被代码静默回答。

### D3. 用测试表达「两个用例只差一个开关，却断言相反顺序」

`scripts/test-worker-pool.mjs` 的三条用例（排序生效 / 开关关闭回到 FIFO / 排序不扩容量）是这条需求的可执行形态。spec 的 Scenario 与之逐条对应，避免"spec 一套、测试一套"。

## Risks / Trade-offs

- **[风险] 开关打开后，排队中的定时触发被点火任务持续插队** → 缓解：排序只在同一次派发决策里选人，不改变老化与顶替规则；且缺省关闭，开启是一次显式运维决定。
- **[风险] spec 改完后，缺省关闭的开关让"能力存在但未启用"难以从 spec 看出** → 缓解：Scenario 明确写"开关关闭时退回先入先出，与变更前逐字节一致"，读者不会误以为生产已在用新顺序。
- **[风险] 后续有人把 `queuedBy` 当作容量依据** → 缓解：spec 用「SHALL NOT 互相替代」双向约束，并有测试用例对照（一条真唤醒仍占额外槽）。

## Migration Plan

- 无数据迁移、无部署顺序要求。
- 回滚：本次仅 spec/测试/文档，代码零改动；回滚即还原 spec 文件。
- 上线开关（若裁决开启）：改 `.env` 或 `platform-config` ConfigMap 后滚 pod（这些值在进程启动时读取）。

## Open Questions

- **点火是否应获得额外槽**：现状授予「否」。若裁决为「是」，需要扩容量语义（额外槽不再是唤醒专属），会改变 spec 的"排序不扩大容量"条款——因此它不能在本 change 内随手决定，须另开 change。
- **上线前置**：开启 `QUEUE_HUMAN_PRIORITY` 之前，`fix-stale-drop-respects-period` 必须已生效。否则点火越过排队后，一条日更/周更轮会被推过陈旧度线并被整轮丢弃（`skipped` 不补跑、不计 `missed`）。两单的顺序是：先放宽丢弃判据，再放行插队。
