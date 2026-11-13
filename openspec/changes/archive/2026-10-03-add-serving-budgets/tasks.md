# Tasks: add-serving-budgets

## 1. 契约与部署侧

- [x] 1.1 `lib/pack-manifest.js`：`serving.budget.turnMinutes` 校验（正整数≤120，多余键拒绝）+ 单测（合法/非法形状、无 budget 兼容）。验证：`node --test scripts/test-agent-serving.mjs` 新增用例绿
- [x] 1.2 `gateway/packs.js` deploy 路由：`budgets` 覆盖解析与校验（同 rhythms 位置）；`lib/agent-serving.js` `composeDescriptor` 增 `effective_budget_minutes`（覆盖→契约→缺省）。验证：单测三态（覆盖/声明/无）落描述符

## 2. runner 执行

- [x] 2.1 `agent-runner/{config,child,manager}.js`：spawn spec 携 `turnBudgetMs`；超时 settle 错误文案指名 `${minutes}m` 上限并标记 budgetKilled；manager 在异常路径移除并停掉被杀 child（下次触达重生）；HarnessClient requestTimeoutMs 随预算；meter 行带 budgetKill。验证：单测——假 harness 慢回合超预算→错误文案/child 移除/计量三断言
- [x] 2.2 无 budget 描述符行为不变（默认 180s 路径回归）。验证：既有 `scripts/test-agent-runner.mjs` 全绿

## 3. 端到端与文档

- [x] 3.1 staging e2e：部署 budget=1m 测试 agent（慢技能 sleep）→ message/send 超限 → 断言结构化错误指名 1m、child 重生可再答、meter.jsonl 有 budgetKill 行。验证：探针脚本留档 scripts/
- [x] 3.2 文档：DEPLOY.md 预算段（契约字段/覆盖/env 默认/硬停语义与 dsh interrupt 展望）。验证：文段与 spec 一致
