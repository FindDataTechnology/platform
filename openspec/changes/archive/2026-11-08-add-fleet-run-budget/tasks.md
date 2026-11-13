# Tasks — add-fleet-run-budget

## 1. 声明与校验（`server/fleet-orchestration.js`）

- [x] 1.1 `normalizeRunBudget(raw)`：三可选正整数维度，非法/缺失 → null（= 无上限）
- [x] 1.2 `runBudgetDeclared(budget)`：至少一个维度非 null
- [x] 1.3 `constraintsOf` 返回 `runBudget`
- [x] 1.4 `validateOrchestration`：非对象 / 未知维度 / 非正数 / 声明了却空 —— 逐条结构化拒绝
- [x] 1.5 通用「约束必须是正数」的循环要**跳过** `carrier` 与 `runBudget`（原本会把它们误杀）

## 2. run 头行的停车事实（`server/routes/fleets-db.js`）

- [x] 2.1 `fleet_runs` 加 `stopped_at` / `stop_reason`（`try { ALTER } catch {}` 幂等）
- [x] 2.2 `deserializeRun` 暴露 `stoppedAt` / `stopReason`
- [x] 2.3 `stopRun(runId, {reason})`：`WHERE stopped_at IS NULL`，首次写入者胜
- [x] 2.4 `runUsage(runId)`：回合数 / token 合计 / 未上报回合数 / 起始与停车事实（现算不落计数器）
- [x] 2.5 `finalizeRun` **不碰**这两列（测试钉住：收口后原因仍在）

## 3. 点火闸（`server/fleet-handoffs.js`）

- [x] 3.1 `export function runAdmissionBlocked(db, engine, runId, budget, {now})`（纯函数）
- [x] 3.2 runId 取 `ledgerTurn.runId ?? job.origin.fleet.chain.runId`
- [x] 3.3 已停车 → 拒；回合数（含在飞）/ token / 墙钟任一越界 → 拒
- [x] 3.4 预算触顶时把上限写进 `stop_reason`（一次），随后所有点火都被同一闸挡住
- [x] 3.5 灭火时落一条事实行 `edge ignition refused: …`，lane 由真实成员行推导
- [x] 3.6 未知 run 永不拦截（读不到账不能挡工作）

## 4. 停车入口（`server/fleet-runs.js` + `server/routes/fleets.js`）

- [x] 4.1 账本 `stopRun(runId, {reason, abortTurn})`：先落头行，再按 run 的 open 句柄取
      `sessionIds` 逐个交给中止注册表；返回 `{run, abortedTurns}`
- [x] 4.2 `POST /:id/runs/:runId/cancel`（owner 门、未知/他舰队 404）
- [x] 4.3 幂等：已停车 → `alreadyStopped: true`，不重复中止，不覆盖原因
- [x] 4.4 无账本挂载时降级：头行照样落章（degrade open）
- [x] 4.5 读面 `runListEntry` 增 `stoppedAt` / `stopReason`

## 5. 测试（`scripts/test-fleet-run-budget.mjs`，新增 9 条）

- [x] 5.1 声明：归一化 / 未声明即无上限 / 畸形与空声明拒绝
- [x] 5.2 闸：三个维度互相独立；未知 run 不拦
- [x] 5.3 点火：上限拦下下游 + 头行记原因 + 事实行可读
- [x] 5.4 点火：已停车 run 即便预算宽松也拒；幂等保留首因
- [x] 5.5 收口不清停车事实
- [x] 5.6 路由：取消成功 / 重复幂等 / 未知与他舰队 404 / 在飞会话被中止
- [x] 5.7 **反向证明**：把点火闸短路成 `const blocked = null` → 两条点火用例红；恢复后全绿
- [x] 5.8 `scripts/test-fleet-runs.mjs` 的迁移列数断言跟上（12 → 14，并点名两列）
- [x] 5.9 相邻套件：orchestration 18 / runs 26 / core 22 / delegation 25 / fanout 5 / 本套件 9

## 6. 门禁

- [x] 6.1 `npx biome check`（五个源文件 + 两个测试文件）绿
- [x] 6.2 `openspec validate add-fleet-run-budget --strict` → `is valid`
- [x] 6.3 全量逐文件扫（每文件 100s 超时）：428 文件 / **3879 条全绿、零红**；
      仅 2 个既知超时（`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）

## 7. 上线

- [x] 7.1 出片滚版 → 已在产（快照取自远端线 620fdd951 → GHA `sha-571b018`，digest `sha256:cfa6bcb2`，
      relay OK 08:20；fd-infra-deploy `b136199` 双 bump → ArgoCD 75s 内两边到位 → 两 rollout 完成；
      镜像内 `test-fleet-run-budget`+`test-fleet-runs` = 35/35 绿；实弹探针：runBudget 归一化正确、
      `fleet_runs` 迁移后 14 列含 stopped_at/stop_reason）
- [ ] 7.2 观察项：滚版后在真实舰队声明一个 `runBudget`，确认超限时不再生长且事实行可读；
      对一条在飞 run 点一次取消，确认落 interrupted

## 8. 挂账（不在本变更）

- 8.1 `spanMax` 仍是 advisory（只告警）——要不要升级成硬界需另裁，本变更不动
- 8.2 预算按 token 而非 USD：价格只在日汇总行，按 run 计价要新缝
- 8.3 拒绝行按每次进入写一条（可审计但会随重试变吵）；要去重可按 run 收敛
