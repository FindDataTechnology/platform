# Tasks: fix-fleet-operator-pause-durability

> 本 change 只立规格，代码实施在批准后单独落（按项目规则改 release 线并出片滚版）。

## 1. 规格（本单内完成）

- [x] 1.1 `specs/agent-fleet-core/spec.md`：1 条 ADDED Requirement + 5 个 Scenario——验证：`openspec validate fix-fleet-operator-pause-durability --strict` 通过
- [x] 1.2 `proposal.md`：Why（含 2026-11-10 实测时间线与排除项）、What Changes、Impact——验证：三节齐备
- [x] 1.3 `tasks.md`：规格与实施分账——验证：本文件

## 2. 实施（批准后，另单执行）

- [ ] 2.1 `task-engine.js`：`pausedBy` 进 `saveTasks` 白名单，`loadTasks` 缺省按 `"fleet"`
- [ ] 2.2 `cron.js`：`pauseJob` 接受来源参数，API 路由调用写 `"operator"`，`resumeJob` 清空
- [ ] 2.3 `fleet-reconcile.js`：resume 分支前置判定 `pausedBy === "operator"` 跳过，回执加 `respectedPause`
- [ ] 2.4 回归测试：4 个 Scenario 各一条；其中「目录变更不撤销人工暂停」须在修复前红、修复后绿
- [ ] 2.5 上产验证：暂停一个真实成员任务 → 触发一次成功目录变更 → 仍 `paused=true`，回执含 `respectedPause`
