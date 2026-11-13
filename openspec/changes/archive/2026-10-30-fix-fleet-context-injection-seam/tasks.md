## 1. 引擎钩子（task-engine.js）

- [x] 1.1 `initTaskEngine` 增 `beforeTurn` 参数并挂 `beforeTurnFn` 模块变量（与 `onFinished` 同型；测试文件 `scripts/test-task-engine.mjs:113` 的恢复用例保绿）——验证：`node --test scripts/test-task-engine.mjs` 全绿
- [x] 1.2 `runExecutionTurn` 在组装 `effective` 前 `await beforeTurnFn?.(t)`，钩子异常 catch 后转 `finishExecution(ok:false, error)` 不炸引擎主链——验证：单测注入一个抛错钩子，断言该次执行落 failed 且后续任务照常执行

## 2. 注入缝实现（cron.js）

- [x] 2.1 `applyFleetContext` 改造为缝的实现：签名改吃 task record；组合规则 = 前缀（`t.catchUpPending`）+ `base = t.promptOverride ?? t.prompt` 的占位符替换（占位符不在则跳过渲染）；空段/渲染失败抛结构化错误——验证：单测三种输入（占位符在/不在/渲染抛错）各断言最终 prompt 形状
- [x] 2.2 `initCron` 把该实现注册为 `beforeTurn`；`fireTask` 与 `runJobNow` 的 enqueue 侧 `applyFleetContext` 调用删除（`fireTask` 只留校验+enqueue）；补跑扫描（cron.js:69-79）删 promptOverride 预写、只置 `t.catchUpPending = true`——验证：`node --test scripts/test-cron-catchup.mjs scripts/test-fleet-report-lane.mjs` 全绿，其中「手动戳发同样注入」用例改缝后口径仍断言 prompt 已展开
- [x] 2.3 空段/渲染失败的显性失败落史口径迁移：从「入队前 recordFailedFire」改为「执行内 finishExecution(ok:false)」，history 行含结构化 error 文案——验证：单测断言渲染失败时该任务 history 末条为 failed 且 error 含 render failed 字样、无裸模板回合产生

## 3. 路径 × 断言矩阵（新增测试）

- [x] 3.1 **恢复队列注入**（本变更的主验收例）：构造 fleet 任务置 `state:"queued"` 落 jobs.json → 重新 `initTaskEngine` + `drainRepairQueue` → 断言起轮 prompt 已含注入段且 `{{fleetContext}}` 不残留——验证：`scripts/test-task-engine.mjs` 或 `test-cron-catchup.mjs` 新增一例，复刻 2026-10-30 真机实证的 283 字符裸模板缺陷为回归测试
- [x] 3.2 **补跑前缀共存**：置 `catchUpPending` 触发带占位符任务 → 断言 prompt 以【补跑】开头且其后为渲染完成的注入段（前缀与上下文同时在场）——验证：单测断言两段同在且前缀在前
- [x] 3.3 **决策送达不双注入**：既有决策送达路径（fleets.js:2181）用例保绿，外加断言其 override 无占位符时缝跳过渲染——验证：`node --test scripts/test-fleet-decision-lane.mjs` 全绿

## 4. 回归与出片

- [x] 4.1 全量回归：`node --test scripts/test-task-engine.mjs scripts/test-cron-*.mjs scripts/test-fleet-*.mjs` 全绿 + biome 干净——验证：CI 或本地全量跑通
- [x] 4.2 出片滚产（走私有构建池；快照 sha 与源真 sha 对应关系写入 GitOps 注释）——验证：pod 内 grep 缝特征串（如 `beforeTurnFn`）命中
- [x] 4.3 真机复现验收：在带占位符的活舰队上触发任务 → 立即滚版 → 恢复执行 → 断言落库 prompt（chat 镜像 user 行）含注入段与（若命中补跑）【补跑】前缀——验证：取证脚本对照 2026-10-30 的 283 字符缺陷形态，确认消失
  - ✅ 生产 A/B（同一条恢复通道，cell 1da519d4c1c0bf89 公司式集群）：
    修复前 `chat_messages#5655`（10-30 00:04）= 283 字符、【补跑】在、`{{fleetContext}}` **原样残留**、无巡视上下文/自身轮次；
    修复后 `#6181`（10-30 05:04，滚版+重启后由恢复/补跑通道起轮）= **6330 字符**、【补跑】在、占位符零残留、巡视上下文+自身轮次段俱在。
    另 `#6187`/`#6199`（恢复队列通道，05:06/05:08）1965/1849 字符，占位符零残留、四段俱在。
  - ✅ 补充直接实证：在生产 pod 内用镜像真实 `cron.js`+`task-engine.js`+真实舰队库跑「persisted queued → 重启 → drainRepairQueue」，起轮 prompt 5738 字符、占位符零残留、四段俱在。
