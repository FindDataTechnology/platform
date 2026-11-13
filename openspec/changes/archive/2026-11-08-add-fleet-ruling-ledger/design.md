# Design — add-fleet-ruling-ledger

## D1 归属从既有数据解出，不新造身份

汇总回合的"我是哪个岗"必须能答，否则 O1 行落不了。两个来源，都已在库里：

| 波型 | initiator | 归属 |
|---|---|---|
| 声明 judge | `fleet:<fleetId>:<judgeId>`（合成值，切片⑤前就有） | 直接解析 |
| 无 judge | 上游岗的会话 id | 该波 hop 上的 `origin.fleet.byMemberId`（本次新增） |

**为什么加 `byMemberId` 而不是查库反解**：无 judge 波的 initiator 是会话、不是岗位，
唯一能说出"谁点的火"的地方就是点火侧（`igniteFleetEdges` 手里就有 `memberId`）。
写进 `origin.fleet` 与 `ignition`/`depth`/`wave` 同族（都是溯源），且**老任务不受影响**
——缺这个字段就不造节点，行为与改动前一致。

**不猜**：两者皆无（例如升级前入队的波）→ `rulingTurnJob` 返回 null → 汇总照发、不写节点。

## D2 节点开在 prompt 之前

`begin` 必须在 `session.prompt`/`dshBridge.prompt` **之前**：裁决回合内的
`dispatch_post` 会在回合中途找"当前在飞的回合"来盖链位（`lookupByMember` /
`lookupBySession`）。若在 prompt 之后再开，第二轮派发的 `parentTurnId` 会指回上一波，
辩论树就断在裁决回合这里——正是本次要修的那件事。

## D3 两条注入路径的 usage 口径不同，都如实

- **collector 路径**（用户切走 / 无 web 会话）：`collectTurn` 直接给出
  `{text, error, usage, firstAssistantAt}` → 精确落账。
- **live 路径**（当前会话就是发起者）：usage 由 dsh-events 的 finishTurn 收口，
  聚合器拿不到 → 落 `ok` 但**不带 usage**。这是诚实空缺；编一个数字才是错的。

## D4 边种类与父回合

节点继承该波的 `chain`：`runId`（同一 run）、`parentTurnId`（该波发起回合）、
`edgeKind`（`fanout`）。于是时间线上"根→主编→扇出波→裁决"连成一条，
而不是每次汇总冒出一个孤立 run。

`source` 由既有派生规则给出：因为合成 job 带 `initiator`，`buildTurnRequest` 判为
`delegation`——正是这条车道，不需要新增 `TURN_SOURCES` 枚举值（新增会波及读面校验与前端过滤）。

## D5 run 收口

`end` 只写回合行并注销句柄，**收口是单独一步**（`settle(runId)`）。
在 `end` 之后立刻 settle：此时该 run 无在飞句柄、无排队任务，`finalizeRun` 会用
回合行重算合计（含刚写入的裁决回合）并闭合头表。若该 run 之前已被 settle（波先收口、
汇总后到），`begin` 会 `reopenRun` 再在 `end` 后重新收口——状态如实经历一次重开。

## R1–R4

- **R1 双计**：汇总回合的行是**新增**的一行，不修改任何波内回合的行；合计随之 +1，正确。
- **R2 崩溃窗口**：`begin` 后进程死 → 句柄只存在内存，重启后该回合行不存在（没 `end`）。
  与既有引擎回合语义一致（那边有 `interrupted` 回填，这边没有），属已知缺口，见挂账。
- **R3 live 路径无 usage**：见 D3。成本读面对这一行显示"未定价"，不虚构。
- **R4 老数据**：缺 `byMemberId` 的波不造节点；`rulingTurnIdentity` 有单测钉住这条。
