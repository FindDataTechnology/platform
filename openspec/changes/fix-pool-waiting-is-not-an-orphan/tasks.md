## 1. 抽谓词

- [ ] 1.1 在 `task-engine.js` 抽 `isOnChain(t)`：`pendingExecutions` 含其 id、或等于 `inFlightExecutionId`、或 `slotDispatcherFn?.claims?.(t.id)` 为真——验证：新增单测直接断言三态（各自为真、皆非为假），并断言 `claims` 缺失时退化为两态
- [ ] 1.2 周期清扫改调该谓词（替换 `task-engine.js:1135` 的内联判断），行为保持不变——验证：`1c003d38b` 引入的「claimed 不重派」用例继续绿
- [ ] 1.3 `queueHealth` 的孤儿计数改调同一谓词（替换 `:1904-1911` 的内联构造）——验证：`scripts/test-queue-health.mjs` 既有用例全绿

## 2. 验收（用实验复现，不靠推断）

- [ ] 2.1 复现本次实验：`TASK_WORKER_MAX=1`、A(persona=code) 占满槽、B(persona=intel) 被池认领——验证：连续两次 `queueHealth()` 后 `orphaned === 0` 且 `degraded === false`（当前实测为 `1 / true`，修好后应翻转）
- [ ] 2.2 真孤儿仍被计入：把 `claims` 置空后同构造——验证：`orphaned > 0` 且 `degraded === true`，证明谓词没有把自愈一起关掉
- [ ] 2.3 池未启用（cap 0）时两态退化——验证：既有 chain 模式下的 orphan 用例全绿
- [ ] 2.4 池关闭路径确实解除注入（design 风险 1）——验证：`attachWorkerPool` 的关闭/重挂路径调用 `setSlotDispatcher(null)`；用例断言关闭后 `claims` 不再影响判定

## 3. 回归

- [ ] 3.1 `node --test scripts/test-queue-health.mjs scripts/test-worker-pool.mjs scripts/test-queue-staleness.mjs scripts/test-fleet-context-pressure.mjs` 全绿——验证：退出码 0；基线为 12 + 18 + 15 + 14
- [ ] 3.2 反向验证：把 1.1 的 `claims` 分支删掉，2.1 必须转红——验证：临时改动后运行该用例，再改回
- [ ] 3.3 `scripts/lint-changed.mjs` 通过——验证：退出码 0

## 4. 收口

- [ ] 4.1 `openspec validate fix-pool-waiting-is-not-an-orphan --strict` 通过——验证：返回 valid
- [ ] 4.2 出片后产线复核：池有等待时 `/readyz` 的 `degradedCells` 不再恒真——验证：连续 10 分钟采样，`degraded` 随真实故障变化；同一批 id 的重复重派日志已消失
- [ ] 4.3 归档——验证：`openspec archive fix-pool-waiting-is-not-an-orphan --yes --strict` 成功

## 5. 关联

- [ ] 5.1 在 `fix-operator-ignition-priority` 的 design 补一句：池等待的可见性由本单负责，该单只处理排序——验证：两处文档互相指向，不重复描述同一机制
