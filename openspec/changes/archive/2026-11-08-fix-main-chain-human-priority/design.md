# Design — fix-main-chain-human-priority

## D1 为什么必须改成「出队时选序」

现状是 `executionQueue = executionQueue.then(() => run(id))`——入队即挂尾。promise 链一旦挂上
就没有任何重排手段，所以「人优先越过未开始的执行」不可能在旧结构里实现。改成：

- `pendingExecutions`：待执行条目 `{ id, human }`，按到达顺序 push；
- `drainExecutions()`：一次只把下一条挂到链上——`findIndex(e => e.human)` 命中即取该条，
  否则取队首；
- 执行结束（成功或抛错都要）再 drain 下一条。

`executionDraining` 是「链上是否已有一条属于本队列的执行在跑」，不是并发数——串行语义不变，
`maxConcurrent` 仍恒为 1（测试 3 断言）。

## D2 为什么不能越过正在跑的那一条

正在跑的执行已被链持有，越过它等于并发执行（主槽是单一 dsh 运行时，切 persona 会打断它）。
所以规则只能是「越过未开始的」，这也正是主人感受得到的那部分：积压是排队，不是正在跑。

## D3 为什么 `idle()` 必须一起改

`idle()` 原先是 `executionQueue.then(() => {})`，即「等 promise 尾部」。惰性出队后尾部可能
只覆盖当前一条，后面还有待执行条目——测试与优雅退出都会在队列没清空时以为完成了。
新实现循环：只要 `executionDraining` 或列表非空，就等当前尾部 + 让出一个 microtask
（drain 在尾部的完成回调里挂下一条），直到清空。

## D4 为什么不动 worker 池

池开着时 `dispatch` 先问 `slotDispatcher`，被认领的执行根本不进主链；池的额外槽
（人满时给人唤醒）是另一条已上产的规则，产线不使用（cap 0）。这一刀只修「产线真实配置下
`humanPriority` 完全失效」这一件事，不改池的行为。

## D5 次序的确定性

「humanPriority 优先 + 其余按到达顺序」是确定性的：同一输入序列得到同一执行序列，不依赖
时间或随机。`task-engine` 里「deterministic order」的措辞因此需要补上这条具体规则，而不是
留空让人各自解释。

## Risks

- R1 人的唤醒连续到达 → 普通执行延后：人的唤醒本身串行且稀有，且每条完成后立即 drain，
  不会饿死；`humanPriority` 只由「立即执行」打上，不来自 cron/a2a/委派。
- R2 其它直接操作 `executionQueue` 的代码：只有 `chainTurn`（委派汇总回合）与 `idle()`。
  `chainTurn` 仍挂尾部——某条执行在跑时，它排在当前执行之后、下一条待执行之前，
  这正是「汇总回合不该排在积压后面」的想要方向。
- R3 任务在被选序前被删除/暂停：`runQueuedExecution` 已有的前置检查照旧生效（`!t` 或
  scheduleSideBlocked → 直接返回）。
