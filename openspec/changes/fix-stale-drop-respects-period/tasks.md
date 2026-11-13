## 1. 周期判定

- [x] 1.1 在 `task-engine.js` 增加「排期周期毫秒」的解析（从 `t.interval` 的 unit/number；覆盖 `interval` 为 null / 非法 / 未知 unit 三种情况，后者返回 null 表示判不出）——验证：新增单测直接断言解析结果表（分钟/小时/天/每 40 天/缺失/非法各一条）
- [x] 1.2 `dropIfStaleQueued` 增加周期感知：`periodMs === null` 时保持既有丢弃；`periodMs < 长周期下限` 时丢弃；`periodMs >= 下限`（默认 6 小时，`QUEUE_STALE_EXEMPT_MIN_PERIOD_MS`）时豁免——验证：针对同一函数的三态单测（判不出→丢、小时级→丢、日更→留），并有一条断言「下限 MUST NOT 由上限度派生」的反例（下限设成 Infinity 时豁免为空）

- [x] 1.3 下限从环境读取 SHALL 在每次调用时解析（与 `queueMaxAgeMs` 同形），MUST NOT 在模块加载时冻结——冻结会让后续 env 变更与测试内的重指向全部失效；开关名 `QUEUE_STALE_EXEMPT_MIN_PERIOD_MS` 已登记进 `.env.example` 与 `DEPLOY.md` 的逃生阀表——验证：`staleExemptMinPeriodMs` 的用例断言"改 env 后无需重启即生效"，且 `grep -qx QUEUE_STALE_EXEMPT_MIN_PERIOD_MS .env.example` 命中

## 2. 文案与两条路径一致

- [x] 2.1 丢弃分支的 error 文案区分两种情况：周期 ≤ 上限时保留「由下一次排期接替」；豁免分支不产生丢弃文案（因为不丢弃）——验证：断言丢弃文案含等待分钟数与上限，且不含对长周期不成立的表述
- [x] 2.2 确认出队路径与周期清扫共用同一判据（不新增第二处年龄比较）——验证：`grep -n "queueMaxAgeMs\|queueAnchorMs" task-engine.js` 只在 `dropIfStaleQueued` 内出现年龄比较
- [x] 2.3 `QUEUE_MAX_AGE_MS=0` 时周期感知同样不生效——验证：置 0 后长周期与短周期排期轮均不被丢弃

## 3. 回归

- [x] 3.1 既有陈旧度用例全绿（它们钉的是短周期与"被持续插队"语义）——验证：`node --test scripts/test-queue-staleness.mjs` 全绿，且其中"被持续插队的过龄排期轮"用例仍以小时级任务为前提
- [x] 3.2 新增用例：日更排期轮在多次人工点火插队后仍留在队列——验证：构造 `queuedBy=human` 点火序列 + 日更任务，断言其 state 仍为 queued 且未被记 skipped
- [x] 3.3 新增用例：每小时排期轮在同一场景下仍被丢弃——验证：同上构造，断言 skipped 且 error 含"下一次排期"
- [ ] 3.4 队列健康观测面不被误伤——验证：豁免发生后 `queueFairnessSnapshot` / `/readyz` 的 `oldestQueuedMs` 语义不变（仍是等待时长），且 `degradedCells` 的判据阈值未因此常亮（人工核对一次真实读数）
- [x] 3.5 **豁免不得把健康 cell 判成 stalled**（design 风险 1）：被豁免的轮 SHALL NOT 参与 `queueHealth().oldestQueuedMs` 的取最大，或等价地显式不参与 `stalled` 判定——验证：构造「队列里只剩一条被豁免的日更轮 + 无回合收口 + 已过 10 分钟」，断言 `degraded === false`；同一构造下把该轮换成周期 ≤ 上限的任务时，仍应正常丢弃而不是停留在队列里顶高指标

## 4. 收口

- [x] 4.1 `openspec validate fix-stale-drop-respects-period --strict` 通过——验证：命令返回 valid
- [ ] 4.2 归档——验证：`openspec archive fix-stale-drop-respects-period --yes --strict` 成功，`openspec/specs/cell-execution-queue/spec.md` 中该需求已含周期感知条款
- [x] 4.3 在 `fix-operator-ignition-priority` 的 design Open Questions 里补一句：点火优先的上线前置是本 change 已生效——验证：两处文档互相指向

## 4b. 已知副本（记录，不阻塞）

- [x] 4b.1 `interval` 单位表在 `cron.js`（`UNIT_MS`）与 `task-engine.js`（`INTERVAL_UNIT_MS`）各一份——引擎不能反向依赖调度前端，副本是有意的；已在 design 的 Open Questions 记下"扩展单位时两处必须同步"，验证：design.md 的 Open Questions 含该条

## 5. 上线顺序（不阻塞归档）

- [ ] 5.1 出片后观察一个日更周期：确认无长周期轮被丢弃、`oldestQueuedMs` 未异常抬升——验证：对比上线前后 24h 的 `skipped` 计数与 `oldestQueuedMs` 分布
- [ ] 5.2 观察通过后再设 `QUEUE_HUMAN_PRIORITY=1`（属另一个 change 的部署动作，不在本单实施）——验证：设置后确认人工点火确实越队，且日更轮仍未被丢
