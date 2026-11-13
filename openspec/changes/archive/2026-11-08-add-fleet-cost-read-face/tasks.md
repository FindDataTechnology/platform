# Tasks — add-fleet-cost-read-face

## 1. 落到回合行（`server/routes/fleets-db.js`）

- [x] 1.1 `member_turn_events` 加 `cost_input_usd` / `cost_output_usd` / `cost_cache_write_usd` /
      `cost_cache_read_usd`（可空；`try { ALTER } catch {}` 幂等）
- [x] 1.2 写入缝把这四列与 `pricing_at` 同批写入（未定价落 NULL，不落 0）
- [x] 1.3 `costOf(row)` → `{inputUsd,outputUsd,cacheWriteUsd,cacheReadUsd,totalUsd,pricingAt}`；
      四列全空 → `null`
- [x] 1.4 `deserializeTurnEvent` 暴露 `cost`

## 2. 三个切面

- [x] 2.1 `runCosts(fleetId,{sinceMs})`：一次 `GROUP BY run_id` → Map（列表页不做 N+1）
- [x] 2.2 `runCost(runId)`：单条，与 2.1 同源 SQL
- [x] 2.3 `spendProjection` 各窗口增 `costUsd` + `pricedTurns`（无已定价回合 → null）
- [x] 2.4 `edgeTraffic` 增 `costUsd` + `pricedTurns`（取**下游**回合的四列之和）
- [x] 2.5 导出 `runCosts` / `runCost`

## 3. 读面接线（`server/routes/fleets.js`）

- [x] 3.1 `runListEntry(run, titles, costEntry)` 增 `cost`
- [x] 3.2 run 列表：整页一次查询后逐条附带
- [x] 3.3 run 详情：`db.runCost(runId)`
- [x] 3.4 `turnTimelineEntry` / `runTurnEntry` 增 `cost`（逐回合）
- [x] 3.5 取消响应里的 run 也带 cost（形状一致，不缺口）
- [x] 3.6 owner board 的 fleet 行累加 `costUsd` / `pricedTurns`

## 4. 测试

- [x] 4.1 新套件 `scripts/test-fleet-cost-read-face.mjs`（5 条）：逐回合 cost/null、
      run 切面+样本量、边切面取下游、窗口金额与空舰队 null、路由（/spend、run 详情、run 列表）
- [x] 4.2 **推翻 D4a 的显式记录**：`scripts/test-turn-pricing.mjs` 原本断言
      「NO money columns on the turn row (D4a)」，改为断言四列存在 + 值与日汇总**一致**
      （把重复变成交叉校验，而不是删掉断言）
- [x] 4.3 **反向证明**：把回合行四列改回 `null`（即 D4a 状态）→ 新套件 5 条全红；恢复后全绿
- [x] 4.4 相邻套件：turn-pricing 7、turn-metering 7、fleet-runs 26、fleet-core 22、
      fleet-orchestration 18、fleet-run-budget 9

## 5. 门禁

- [x] 5.1 `npx biome check server/routes/fleets.js server/routes/fleets-db.js scripts/test-fleet-cost-read-face.mjs scripts/test-turn-pricing.mjs` 绿
- [x] 5.2 `openspec validate add-fleet-cost-read-face --strict` → `is valid`
- [x] 5.3 全量逐文件扫（每文件 100s 超时）：431 文件 / 3813 条。扫描期间并发线正在改文件，
      出现 18 个瞬时红；逐文件隔离复跑后 **16 个全绿**（含 pack-marketplace 8/8、
      websearch-settings 7/7、turn-dispatch 17/17、workspace-boot 15/15）。余 2 个红
      **在 clean HEAD worktree 上同样红**，与本 change 无关：
      ① `test-pack-cell` 断言 `/not a registry server/`，实际文案已被并发线改名成
      "not a market server (an installer-shipped starter; …)"；
      ② `test-supply-store-migrate` 的 dual-read 用例跑的是并发线在途的
      `scripts/supply-store-dual-read.mjs`（退出码语义变了）。
      本 change 自己的面（fleets-db 回合写入 + 三个读面）全绿

## 6. 上线

- [x] 6.1 出片滚版 → 已在产（快照取自远端线 bbc147390 → GHA `sha-873377b`，digest `sha256:80be630f`，
      relay OK 09:41；fd-infra-deploy `fe67e13` 双 bump → ArgoCD 75s → 两 rollout 完成；
      镜像内 `test-fleet-cost-read-face`+`test-turn-pricing` = 12/12 绿；
      实弹探针：回合行四列存在、`runCost` = {usd:1, pricedTurns:1, turns:1}、`spendProjection` 同值）
      ⚠️ 过程事故：本 change 的源码面曾整批丢失（共享工作树被并发线改写），首次提交只带上
      openspec 与新测试；已按远端线内容重贴三处源码并在 clone 内验证后重推（`bbc147390`）
- [ ] 6.2 观察项：滚版后取一个真实 run 的详情，确认金额与样本量合理（不为 0、不虚高）；
      核对 cockpit 边流量上的金额与 run 详情同源

## 7. 挂账（不在本变更）

- 7.1 超保留期的 run/边读不到金额是既有裁剪语义（日汇总仍永久保留）；要可追溯需归档层
- 7.2 前端尚未展示新字段（本次只开 API）；画布/时间线怎么呈现金额另裁
- 7.3 USD 仍是估算（价格来自词元价目表 ×1.0 口径），与账单核对的差额面在既有 reconcile 脚本
