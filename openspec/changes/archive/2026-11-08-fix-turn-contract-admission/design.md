# Design — fix-turn-contract-admission

## D1 为什么门放在「起轮前」而不是「入队时」

入队时校验只能挡住「入队那一刻就已超界」的任务；本洞恰恰是**入队之后声明收紧**。放在起轮前
（`cron-runner` 真正跑这一轮之前）才能读到最新声明。位置与「运行时就绪门」相邻：
同样的 `{ ok:false, error }` 收口形状 + `recordFleetTurnEvent` 落事件，不发明新语义。

## D2 为什么必须放在账本开启之前

账本 `begin()` 会给本轮铸造 turnId / runId 并把回合登记进 open 表。若先开账本再拒绝，
这一轮就必须显式 `end()`，否则账本会留一个永不收口的在飞回合（`sweepOpenRuns` 之后才清）。
在 begin 之前返回，账本根本不认识这一轮，拒绝只以「回合事件」这一种事实落库——最干净。

## D3 为什么 null ≠ 拒绝

三态必须分清：`null` = 不是舰队任务或舰队已删（不判）；`{ error }` = 拒绝；无返回值 = 通过。
调用方写成 `if (admission?.error)`，而不是 `if (!admission)`，否则每个非舰队任务都会被拒绝。
这条写进了测试 1。

## D4 为什么复用 assertTurnRequest 而不是另写一份

契约的价值就在「派生与校验共用一份真源」。另写一份等于把界值的定义复制一遍，下一轮必然漂。
`assertTurnRequest` 的界值逻辑本身已正确：`bound = declared >= 1 ? declared : 1`——声明为 0 或 1 时
dispatch 道（depth 1）仍然放行，不会误伤 dispatch。

## Risks

- R1 误伤合法回合：默认声明是 8，dispatch 恒 1，handoff/fanout 点火时已比对同一份声明，
  因此除「声明收紧」这一种竞态外，其余路径校验必过。27 个消费者套件（约 300 条）全绿实证。
- R2 账本未挂载的挂载形态：`?.` 短路，degrade open，与既有可选接缝一致。
- R3 拒绝后的可观察面：失败 + 回合事件（带错误原文），管理面照常能看到这一轮为什么没跑。
