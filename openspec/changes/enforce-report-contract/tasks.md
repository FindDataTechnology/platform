# Tasks — enforce-report-contract

## 1. 契约标记（构建/装载期）

- [ ] 1.1 人设装载处识别「声明了必交报」（正则覆盖 `必 report_status` / `收尾必` / `必须…report_status`），落 `reportContract: "required" | null`
- [ ] 1.2 标记随 profile 的 preset 一起写进运行时（结算读它，不读散文）
- [ ] 1.3 装载期把 `reportContract === null` 的岗位清单打成一行日志（模板改了能看到漏判）

## 2. 结算

- [ ] 2.1 `shapeTurnOutcome` 接收 `reportContract` 与现有 `reported`，在 `ok ∧ required ∧ !reported` 时给 `detail.missingReport: true`
- [ ] 2.2 `failed / interrupted / skipped` 一律不判；`reportContract` 为 null 一律不判
- [ ] 2.3 **status 不变**（仍 `ok`），通过率语义不变
- [ ] 2.4 `cron-runner` 把岗位的 `reportContract` 传到结算缝（与 `metering` 同路）

## 3. 读数

- [ ] 3.1 交付率 = `(ok ∧ !missingReport) / 全部回合`，与通过率并列输出（`spend`/健康面）
- [ ] 3.2 读数头部标注起算日（历史行无该字段）

## 4. 测试

- [ ] 4.1 声明必交 + ok + 未报 → `ok` 且 `detail.missingReport === true`
- [ ] 4.2 声明必交 + ok + 已报 → 无 `missingReport`
- [ ] 4.3 未声明 + ok + 未报 → 无 `missingReport`（不误伤，如 `wire-fleet-content`）
- [ ] 4.4 failed / interrupted / skipped → 一律无 `missingReport`
- [ ] 4.5 反证：把前提从三态改成两态（`ok && !reported`）→ 4.3 红；把 status 改成 failed → 通过率用例红

## 5. 规格

- [ ] 5.1 `agent-fleet-core` 交付契约条款 + 4 场景（随 proposal 写入 delta）

## 6. 上线与观测

- [ ] 6.1 快照 → GHA → relay → digest → GitOps → ArgoCD → 舱内确认标记与 detail 都在
- [ ] 6.2 观测一窗：`missingReport` 条数、按岗位分布；抽查 ≥5 条确认它们确实该报（防"无事可报"被误判）
- [ ] 6.3 出对照：通过率（不变）vs 交付率（起算日前后），并说明基线是 0.25 报/回合
- [ ] 6.4 归档（`openspec validate --strict` 通过后）
