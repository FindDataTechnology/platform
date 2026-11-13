# Tasks — fix-fleet-output-salvage

## 1. 归因（`server/cron-runner.js`）

- [x] 1.1 collector 统计 `compaction/start`（被动计数，不改结算语义），随 idle/timeout 两路带出
- [x] 1.2 `timeoutError(..., { compactions, hasOutput })`：detail 带 `compactions`、`hasOutput`；
      达阈值时置 `contextPressure: true` 并把文案改成 `turn timed out — context pressure (N compactions)`
- [x] 1.3 常量 `CONTEXT_PRESSURE_COMPACTIONS = 2`（只影响命名与是否补收尾，不影响何时停）

## 2. 收尾车道

- [x] 2.1 `shouldSalvageReport(detail, { interrupted, isFleet })` 纯判据（四条件同时成立）
- [x] 2.2 `runWrapUpReport(ctx, { childSessionId, mirrorSessionId, timeoutMs })`：同一子会话、只许 `report_status`、
      独立 90s 预算、任何失败吞掉返回 null
- [x] 2.3 `attempt` 的 catch 接入：满足判据才补，结果写 `detail.wrapUp`，回合结论仍 failed

## 3. 测试（`scripts/test-fleet-context-pressure.mjs`，6 条）

- [x] 3.1 collector 计数：两次 start 计 2，summary 不计
- [x] 3.2 归因阈值：1 次不点名、3 次点名并带次数
- [x] 3.3 收尾 prompt：同会话、只许 report_status、明确拒绝其他工具
- [x] 3.4 收尾失败返回 null（永不成为回合结论）
- [x] 3.5 判据四条件逐条（空产出/有产出/非舰队/中断/未达阈值）
- [x] 3.6 缝级端到端：真超时产生 pressure 归因 → 判据放行 → 收尾补回文本
- [x] 3.7 反证 A：去掉压缩计数 → 3.1 与 3.6 红；反证 B：判据恒假 → 3.5 与 3.6 红
- [x] 3.8 邻接：28 个引用 cron-runner 的套件（约 320 条）全绿

## 4. 规格与文档

- [x] 4.1 `cron-module`：MODIFIED「舰队成员回合预算可按岗位声明」+ 4 个场景
- [x] 4.2 explore 文档 P0′ 段已记录取证与排除过程（上一提交）

## 5. 上线

- [x] 5.1 快照 41b95d9 → GHA image ✅ → relay OK → skopeo digest `sha256:341b9280` → GitOps 9f9f6d1 →
      ArgoCD 对齐 → platform/facet 滚完 → **舱内跑本套件 6/6 绿**；现网 f16306b 的唯一独有提交在本线逐文件哈希一致（不回退）
- [x] 5.2 归档（`openspec validate --strict` 通过后）
