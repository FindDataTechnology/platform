# Tasks — fix-fanout-aggregation

## 1. 分组键落地（`task-engine.js`）

- [x] 1.1 `createManualTask({..., initiatorGroup})` 接收并写入记录（`?? null`）
- [x] 1.2 `saveTasks` 白名单加 `initiatorGroup`（不加则重启即丢，分组退化）
- [x] 1.3 加载路径无需改：`loadTasks` 是 `{...data}` 展开，字段自然回读

## 2. 聚合器按点火键聚合（`server/delegation-aggregator.js`）

- [x] 2.1 `export function aggregationKey(task)` = `initiatorGroup ?? initiator`（回落 = 旧行为）
- [x] 2.2 `groupFor(key)` 用 `aggregationKey` 比较；`armAggregation`/`maybeInject`/`rearmPending` 一律走键
- [x] 2.3 `pendingInjection` 按**键**去重（原按 initiator，两个键会互相阻塞）
- [x] 2.4 `runInjection(key)` 内的会话从 `group[0].initiator` 取——键不是 sessionId，两者不能混用
- [x] 2.5 `export function readyGroups(records)`（纯函数，供测试判定"该不该注入"）

## 3. 扇出接缝（`server/fleet-handoffs.js`）

- [x] 3.1 每条 fanout 边点火前生成 `fanout:<base36 时间>:<随机>`，整波共用
- [x] 3.2 judge / 非 judge 两式都带 `initiatorGroup`
- [x] 3.3 无 judge 分支补 `initiatorPreset: job.preset ?? null`（上游回合实际所用的人格）
- [x] 3.4 注释写清为什么 `origin.fleet.wave` 不能当分组键（恒 1、无人读）

## 4. 测试（`scripts/test-fanout-aggregation.mjs`，新增）

- [x] 4.1 键优先于会话；缺键回落会话；两者皆空 → null
- [x] 4.2 同一会话两次点火 → 两个 ready 组（不合并）
- [x] 4.3 组内有未终态成员 → 不就绪；全组已 `aggregated` → 不重臂
- [x] 4.4 真实 `igniteFleetEdges`：无 judge 波带 `initiatorPreset === job.preset`、整波共用一个键、
      第二波键不同
- [x] 4.5 judge 波也带键，人格仍是 judge 的
- [x] 4.6 **反向证明**：把 `aggregationKey` 还原成只看 `initiator` → 4.1/4.2 红；
      把无 judge 的 `initiatorPreset` 删掉 → 4.4 红。恢复后全绿
- [x] 4.7 相邻套件全绿：`test-fleet-orchestration` 17、`test-fleet-delegation` 25、
      `test-persona-park-lane` 9、`test-task-engine` 29、`test-fleet-turn-budget` 9 = 89 绿

## 5. 门禁

- [x] 5.1 `npx biome check task-engine.js server/delegation-aggregator.js server/fleet-handoffs.js scripts/test-fanout-aggregation.mjs` 绿
- [x] 5.2 `openspec validate fix-fanout-aggregation --strict` → `is valid`
- [x] 5.3 全量逐文件扫（每文件 100s 超时）：427 文件 / **3869 条全绿、零红**；
      仅 2 个既知超时（`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）

## 6. 上线

- [x] 6.1 出片滚版 → 已在产（快照取自远端线 e24cf7cf1 → GHA `sha-4018509`，digest `sha256:c5e71673`；
      ⚠️ 中途被并发线滚的 `sha-f09ac1a` 覆盖过一次——那片基线是 paas 5ad7f47，不含本修，
      已重指回 `4018509`；镜像内 `test-fanout-aggregation` = 5/5 绿，`aggregationKey`×5、
      `initiatorGroup`×3、`initiatorPreset: job.preset`×1 均在）
- [ ] 6.2 观察项：滚版后看真实扇出的汇总回合是否以主编人格说话、两波是否各自汇总
