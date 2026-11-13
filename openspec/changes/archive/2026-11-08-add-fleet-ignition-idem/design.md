# Design — add-fleet-ignition-idem

## D1 回合身份：账本优先，执行序号兜底

`igniteFleetEdges` 已经收 `ledgerTurn`（`server.js:1435-1449` 透传），其 `turnId` 就是
平台其余面归属回合用的标识（`fleet-runs.js` 的 handle）。有它就用它。

没有账本的部署（或测试直连 seam）用 `job.roundSeq`：`cron-runner.js:1321` 每次进入
`runCronJobTurn` 都会 `++roundSeqCounter`，并随 `job` 传到点火点。它标识的是**一次执行**，
正是"重复进入"要去重的那一层。

顺序：`ledgerTurn.turnId` → `${job.id}:r${roundSeq}`。

**为什么不用 startedAt**：`startedAt` 是闭包内变量，没挂在 `job` 上；`roundSeq` 是同一
毫秒内的单调序号，语义等价且已在 job 上。`roundChildSessionId` 用的两者组合，本处不需要
再拼一遍时间戳。

## D2 判定不引入新存储

每个由点火创建的 hop 都把键写进 `origin.fleet.ignition`，而 `origin` 是任务的持久化字段
（`saveTasks` 白名单里的 `origin: t.origin ?? null`，`loadTasks` 用 `{...data}` 展开）。
于是判定只需回读 `engine.allRecords()` 里已有的键：

```js
for (const t of engine.allRecords() ?? []) keys.add(t?.origin?.fleet?.ignition)
```

- 跨重启天然成立（记录本来就要活过重启）；
- 不需要新的表、文件或迁移；
- **已知边界**：那个下游任务被删掉/清理后，键就没了，同一回合再次进入会重造这一 hop。
  这是可接受的——任务被删时那波工作也一并没了；要更严格得另建墓碑表，本变更不做，
  写进 spec 之外的挂账。

**为什么不在 `origin` 之外新建字段**：`ignition` 本身就是溯源（"我是哪一次点火来的"），
和 `origin.fleet` 的既有语义（`depth`/`wave`/`chain`）同族；另开顶层字段反而要把
`saveTasks` 白名单再改一次，白付一次"忘记加就丢"的风险（见 `fix-fanout-aggregation` R3）。

## D3 为什么键里必须有「回合」

如果只按 `(edge, target)` 去重，那**第一次点火之后就永远不再点火**——链条只走一轮，
下一轮节奏、运维重跑、裁决者发起的第二轮辩论全部失效。去重的粒度必须是"一次回合一次点火"
而不是"一个 hop 永远一次"。

测试把这个边界钉死了：`turn_idem_1` 二次进入 → `null`；`turn_idem_2` → 照常两跳。

## D4 与既有语义的交互

- **执行顺序**：判定在建任务之前、深度越界事件行之前 → 重复进入不会刷出第二条
  "depth bound reached" 行。
- **扇出分组键**（`fix-fanout-aggregation`）与点火键正交：前者决定"哪些任务算一次汇总"，
  后者决定"这一次还要不要建任务"。同一回合的二次进入被拦在建任务前，因此也不会产生
  第二个分组键。
- **工具岗 hop**：同样判重（它的 `origin` 也带键）。

## R1–R4

- **R1 误拦真实点火**：键含回合身份，新回合必不撞；同一回合内每个
  `(edge, target)` 只可能合法点火一次，故不会误拦。
- **R2 记录读写失败**：`firedIgnitionKeys` 内部 try/catch——读不出来就当"没有历史"，
  退化为改动前行为（宁可重复也不让点火失败）。
- **R3 性能**：一次点火扫一遍 `allRecords()`，与聚合器每次收口同量级；任务量级是
  "当前驻留任务"，非历史全量。
- **R4 恢复通道**：重启后同一轮被恢复执行会拿到**新的** `roundSeq`（计数器从 0 起，
  恢复任务进的是新执行）→ 会被当作新回合点火一次。这与"恢复后确实还没点过火"一致；
  若上一轮在重启前已点过火，其任务的 `ignition` 键里是旧回合身份，拦不住——这是本变更的
  **已知边界**，与 D2 的删除边界同类，一并记在挂账。
