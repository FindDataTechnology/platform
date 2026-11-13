# Tasks: add-agent-delegation-tools

## 1. 引擎：manual 触发

- [x] 1.1 `task-engine.js` 支持 `trigger: "manual"`：校验（schedule|manual）、`createManualTask({ target, prompt, sessionTitle })` 插入即入队 — 验证：单测——manual 任务创建后经 idle() 落 `done`，无 schedule 字段，re-run 可用
- [x] 1.2 历史条目记录 runtime 上报的 token usage（有则记，无则缺省） — 验证：单测——stub runTurn 返回 usage 时历史条目带 tokens 字段

## 2. 工具面

- [x] 2.1 `server/routes/delegation.js`：loopback REST 桥（create/list/result），internal 身份绑当前 preset — 验证：单测或 curl 冒烟——create 返回任务 id+queued，list 按 session 过滤
- [x] 2.2 `server/delegation-mcp.js`：`delegate_task`（persona+prompt，自委派结构化拒绝）、`task_progress`、`task_result` 三个工具 — 验证：单测——三个工具的返回形状与错误形状（未知 id、自委派）
- [x] 2.3 工具进基线 MCP 配置（对齐 cron 工具的挂载方式），全 persona 可见 — 验证：启动后 agent 工具清单含三工具

## 3. 汇总注回

- [x] 3.1 fan-out 记账：`(发起session, turnRef, taskIds[])` 组，全部终态触发恰好一次注回；记账随任务记录持久化，重启后终态组补注一次、未完组重挂 waiter — 验证：单测——双任务先后完成只注一次；模拟重启后不重复
- [x] 3.2 注回执行：waitForIdle → 记录 system 授权的汇总消息（样式非用户气泡）→ prompt 发起 session → collector 落库 — 验证：smoke——委派两任务完成后发起 session 出现汇总 turn

## 4. 任务卡（两端）

- [x] 4.1 `packages/core`：委派工具调用带 task id 标记；web `TaskCard`（CronToolCard 同款模式）实时态 + token 花费 + persona/prompt 摘要 — 验证：e2e——委派后卡片出现并随状态翻牌
- [x] 4.2 汇总 turn 的渲染样式（task-authored 系统样式，区别于用户气泡） — 验证：e2e——注入 turn 带可断言的 data-testid 与样式类
- [x] 4.3 MP 任务卡（降级形态：状态+persona）+ zh 文案；web 五语言词条 — 验证：check:locales + miniapp typecheck/build

## 5. 收口验证

- [x] 5.1 fast e2e：委派全链路（工具→任务卡→/tasks 出现 manual 类别→汇总注排在空闲后）；现有 cron/task 套件回归绿 — 验证：playwright fast 绿
- [x] 5.2 smoke e2e：真模型委派（delegate→子任务 done→汇总 turn 落发起 session）；中断路径（子任务 interrupted 后汇总点名失败） — 验证：smoke spec 绿（.env key + 双 store 配方）
- [x] 5.3 `openspec validate add-agent-delegation-tools --strict` 通过
