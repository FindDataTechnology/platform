# Tasks — fix-fleet-budget-visibility

## 1. 归因（`server/fleet-events.js`）

- [x] 1.1 `ERROR_KINDS` 增 `budget`，置于 `model_upstream` 之前
- [x] 1.2 匹配规则覆盖中英文（`budget_exhausted` / `over (the) daily|monthly budget` / `额度用尽|打满|耗尽` / `预算超限`）

## 2. 舰队聚合（`server/routes/fleets-db.js` + `fleets.js`）

- [x] 2.1 `budgetPressure(fleetId, { windowMs })`：只读单查询，返回 `{members,failures,since,windowHours}`，无则 `null`
- [x] 2.2 cockpit 的 `health` 增 `budgetPressure` 字段

## 3. 可见面（`web/src/pages/FleetsPage.tsx` + 5 locale）

- [x] 3.1 存在该维度时渲染醒目提示（岗位数/回合数/窗口/最早时刻），无则不渲染
- [x] 3.2 五语种文案；`check-locales` 与 `design-lint` 均通过

## 4. 测试

- [x] 4.1 `scripts/test-fleet-budget-visibility.mjs`（4 条）：分类优先序 / 回合事件 errorKind / 聚合三数 + 窗口 / 连败归因
- [x] 4.2 反证 A：删掉 `budget` 规则 → 2 条红；反证 B：聚合恒 `null` → 1 条红；还原即绿
- [x] 4.3 e2e 新增 2 条：有压力时呈现真实数字（**抓到占位符未替换的真缺陷并修掉**）、无压力时不渲染
- [x] 4.4 `e2e/fleets.spec.js` 全文件 26/26 绿；状态/回合事件五套（7+15+26+9+10）绿

## 5. 上线

- [x] 5.1 快照 c3b88de（我的线）→ GHA image ✅ → relay OK 19s → digest `sha256:ccf828f2`。
      **但未用该镜像上线**：并发发布线 e8799d7 的基线 702940bd9 **已包含我的提交**（`3efd751f8 --not 702940bd9` 为空），
      且对方另有网关代铸修复（`722ba1b9e`）——滚我的 c3b88de 会回退它。改为直接验证现网 e8799d7：
      树内含 budgetPressure(2)/"budget"(2)/fleet-budget-pressure(1)，**舱内跑本套件 4/4 绿**，前端包含横幅与文案
- [x] 5.2 归档（`openspec validate --strict` 通过后）
