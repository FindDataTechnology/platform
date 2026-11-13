# Tasks — fix-cron-list-scope

## 1. 视图

- [x] 1.1 新增 `server/cron-list-view.js`：`shapeCronList(jobs, {scope, limit, offset})` 纯函数；默认 30 / 上限 200 / 未知 scope 回落 user
- [x] 1.2 头部账目：池条数、全量条数、操作者/舰队分项、当前区间、下一页 offset
- [x] 1.3 `cron-mcp.js` 的 `cron_list` 接入（scope/limit/offset 入参、头部 + 行渲染不变）

## 2. 测试（`scripts/test-cron-list-view.mjs`，4 条）

- [x] 2.1 默认只列操作者任务并报出 658 条被排除的舰队量
- [x] 2.2 scope=fleet 只看舰队物化；scope=all 给审计；未知 scope 回落最窄
- [x] 2.3 分页走到底、上限封顶、越界页如实为空（"showing none of N"）
- [x] 2.4 定量：默认页行数不到原全量的 1/5
- [x] 2.5 反证：池改为全量（旧行为）→ 3 条红；还原 4/4 绿

## 3. 规格

- [x] 3.1 `scheduling-cluster-aware`：`cron_list` 分域分页 + 3 场景

## 4. 上线

- [x] 4.1 快照 7b92fa7 → GHA ✅ → relay OK → digest sha256:ed7289a3 → GitOps 2eba07c → ArgoCD →
      platform/facet 滚完 → **舱内 4/4 绿**；并对真实 cell 实弹：817 个任务 → 默认页 30 行、
      头部「817 total: 158 operator, 659 fleet-materialized」
- [x] 4.2 归档（`openspec validate --strict` 通过后）
