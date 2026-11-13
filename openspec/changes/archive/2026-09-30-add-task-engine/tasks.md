# Tasks: add-task-engine

## 1. Store 与迁移

- [x] 1.1 为任务存储加 additive 列（`trigger`、`target_type`/`target_ref`、`state`），写一次性迁移把现有 job 行回填为 `trigger=schedule`、`target=persona`、state 由历史推导，保持 id 稳定 — 验证：迁移在带存量 job 的本地库上跑通，旧行为字段（schedule/preset/session/timezone）不变
- [x] 1.2 实现加载时的状态修复：`running`→`interrupted`（不重跑）、`queued`→重新入队恰好一次 — 验证：单测覆盖两种状态经重启加载后的落点
- [x] 1.3 确认任务写路径保持原子（沿用现有事务模式） — 验证：崩溃注入或事务单测证明半写不破坏已存任务

## 2. 引擎核心

- [x] 2.1 把 `server/cron-runner.js` 的执行流（waitForIdle→preset 切换→prompt→collector→落库→sessions 刷新）原位改造为引擎的主槽执行器，执行前后维护 state 迁移（queued→running→done/failed/interrupted），保留 `abortCronTurns` 注册表 — 验证：现有 cron 执行路径手工冒烟（run-now 一个 job 走完全程，state 落 `done`）
  - 状态注记（2026-09-30）：引擎状态机+真实 runner 的 queued→running→failed 全链路已由单测（stub executor）与 fast e2e（死 LLM，真 runner）验证；`done` 落态的真模型验证被 LLM 网关当前 404 阻塞（既有 smoke chat-turn 同样失败，非本改动引入）。2026-09-30 网关恢复后已补验通过（smoke 1 passed，`set -a; source .env` 带真实 key + 双 store 覆盖）
- [x] 2.2 引擎队列替代 cron 的串行队列：入队、确定性顺序、一次一个；不引入新的 runExclusive 嵌套 — 验证：并发触发多个任务观察顺序执行且无死锁（复用 cron 并发测试模式）
- [x] 2.3 失败与中断记录 error gist 并落 `failed`/`interrupted`；无自动重试 — 验证：LLM 失败注入（dead-LLM 模式）下任务落 `failed` 且带 gist
- [x] 2.4 实现手动 re-run：同一任务身份重新入队，历史保留；已 queued/running 时为 no-op 返回当前态 — 验证：对 failed 任务 re-run 后新执行产生、历史两条
- [x] 2.5 `cron_*` 事件载荷增补任务字段（trigger kind、state、target），lifecycle 变化（created/enqueued/started/finished/interrupted）全部广播 — 验证：WS 监听单测断言新字段与事件序列

## 3. 调度前端收编

- [x] 3.1 `cron.js` 收缩为"何时入队"：调度计算/时区/暂停恢复/run-now 语义不变，触发的落点改为引擎入队 — 验证：现有 cron 行为回归（时区求值、pause/resume、run-now 不影响后续触发）
- [x] 3.2 停机语义保持：missed marker 不追跑、one-shot 过期标记 `expired` — 验证：单测覆盖跨停机的两种场景（沿用现有 cron 停机测试）
- [x] 3.3 创建路径校验 target：仅支持 `persona` 类型，未知类型结构化拒绝 — 验证：非法 target 创建请求返回结构化错误且无任务产生

## 4. /tasks 任务中心

- [x] 4.1 Web 任务页扩为唯一任务中心：列出全部任务（trigger 类别、目标角色、生命周期态、schedule/时区/next run、最近结果），`cron_*` 事件驱动实时刷新 — 验证：Playwright 打开 /tasks 混合任务可见且状态实时变化
- [x] 4.2 任务行加 re-run 动作（failed/interrupted 可用），乐观更新与广播状态对账 — 验证：e2e 对 failed 任务点 re-run 后状态演进正确
- [x] 4.3 MP 任务页同步扩列（生命周期态、re-run 入口），zh 文案走 checked locale 文件 — 验证：`npm run check:locales` 通过 + MP 页面冒烟

## 5. 收口验证

- [x] 5.1 现有 cron 相关 e2e 套件全部原样通过（行为保持门） — 验证：`npx playwright test` cron 相关 spec 绿
- [x] 5.2 新增 e2e：任务生命周期（创建→running→done）、失败落 `failed`、重启后 `interrupted` 标记与 queued 续跑、re-run — 验证：新增 spec 绿
  - 状态注记（2026-09-30）：`e2e/task-lifecycle.spec.js`（fast：failed/gist/re-run/双入队 ack）已绿；`e2e/task-lifecycle-smoke.spec.js`（done + preset 切换中断 → interrupted）已就位，smoke 腿已于 2026-09-30 网关恢复后补验通过；重启语义（running→interrupted、queued 续跑）由 `scripts/test-task-engine.mjs` 以引擎级重启模拟覆盖
- [x] 5.3 `openspec validate add-task-engine` 通过；CRON 章节 README/docs 无需变更的确认（用户面文案在 locale 文件）
