# Tasks — fix-fleet-turn-budget

## 1. 解析器：优先级与夹紧（`server/cron-runner.js`）

- [x] 1.1 `resolveTurnBudgetMs(job, {db})` 增加边预算来源：`job.executionPolicy.timeoutMinutes`（分钟）
  - 非法值（非数字 / ≤0 / NaN）→ 落到岗位声明，而不是直接回默认
  - 边预算同样夹紧 `[2min, 30min]`
- [x] 1.2 解析顺序固定为 **边 > 岗 > 默认**，注释写清"边预算是编排层对这一跳的显式声明，更具体者胜出"
- [x] 1.3 现有六条单测的全部断言保持绿（未声明/越界/非舰队/失败降级四条口径不变）

## 2. 引擎：要数者而非造数者（`task-engine.js`）

- [x] 2.1 `initTaskEngine({ resolveTurnBudget })` 接收解析器；未传/非函数 → `null`
- [x] 2.2 调用点改为 `const budget = resolveTurnBudgetFn ? safeBudget(resolveTurnBudgetFn(effective)) : TURN_TIMEOUT_MS`
  - `safeBudget(v)`：`Number.isFinite(v) && v > 0 ? v : TURN_TIMEOUT_MS`
  - 解析器抛错 → 落默认（`cron-module` 既有条款：解析失败降级，不影响回合启动）
- [x] 2.3 `TURN_TIMEOUT_MS` 注释改为"未注入解析器时的回退默认值"，明确它**不是**预算来源

## 3. 接线（`cron.js`）

- [x] 3.1 `initTaskEngine({...})` 传 `resolveTurnBudget: (task) => resolveTurnBudgetMs(task)`
  （与 runner 共用同一函数，避免两处各算一套）
- [x] 3.2 `cron-runner.js:1284` 的 `turnTimeoutMs || resolveTurnBudgetMs(job)` **保留不动**（其它宿主
  直接调 `runCronJobTurn(job)` 时仍是正确兜底）

## 4. 测试

- [x] 4.1 `scripts/test-fleet-turn-budget.mjs` 扩两层
  - 解析器层（原有）+ ①边预算优先于岗位预算 ②边预算越界夹紧 ③边预算非法时回落岗位声明
- [x] 4.2 `scripts/test-task-engine.mjs` 补交付层断言（**这是缺陷真正的所在**）
  - ④注入解析器返回 20min → `turnFn` 收到的 `turnTimeoutMs === 20*60*1000`
  - ⑤未注入解析器 → 仍是 10min（行为不变）
  - ⑥解析器返回 undefined / 抛错 → 落 10min，回合照常执行（不因预算解析失败而失败）
- [x] 4.3 **反向证明**：把 2.2 改回 `{ turnTimeoutMs: TURN_TIMEOUT_MS }`，④ 必须红；恢复后全绿
  （证明测试对准"预算到达回合"，不是自证）
- [x] 4.4 相关套件全绿：`test-task-engine`(29) + `test-fleet-turn-budget`(9) = 38 绿；
  `test-worker-pool`/`test-cron-parity`/`test-fleet-turn-events`/`test-fleet-orchestration`/
  `test-cron-round-rotation`/`test-cron-catchup` 合计 60 绿
  - 全量`test-*.mjs`（除既挂的 `test-bots.mjs`）**3776 绿 / 3 红（3784 条）**，三红均在会话外/并发在途面：
    `scripts/test-connector-credentials.mjs` 3.2+2.3（断言「non-ref baseline kept」失败）与
    `scripts/test-websearch-settings.mjs`「stored relay pair reaches the patch」——
    两个文件均不 import 本 change 的三个文件（`task-engine.js`/`cron-runner.js`/`cron.js`），
    单跑同样红，落在 connector 绑定/websearch relay 补丁面，系并发在途工作所留，
    **不计入本 change 验收**，但**属滚版阻断项需先裁**

## 5. 门禁

- [x] 5.1 `npx biome check task-engine.js server/cron-runner.js cron.js scripts/test-fleet-turn-budget.mjs scripts/test-task-engine.mjs` 绿
- [x] 5.2 `openspec validate fix-fleet-turn-budget --strict` → `is valid`

## 6. 上线（不含在本 change 内）

- [x] 6.1 出片滚版走 `fd-build-channel pick platform` → 已在产
  - 快照 `9e9d127c0` → GHA `sha-482b815`（hkccr `yizuo/platform` → 同 registry 重打进
    `law-bench/platform:sha-482b815`，digest `sha256:193f4db7`，relay OK 03:55）
  - fd-infra-deploy `778f392` 双 bump platform/facet → ArgoCD → 两 rollout 完成
  - 镜像内实跑 `scripts/test-fleet-turn-budget.mjs` + `scripts/test-task-engine.mjs` = **38/38 绿**
- 6.2 观察项（滚版后 7 天，非本 change 交付物）：按岗位统计 `turn_budget_exceeded` 的发生时长，
  确认声明 20min 的岗位不再在 621s 被杀

## 7. 挂账（同源缺口，不在本 change）

- 7.1 **`turn-request.js:90` 的 `budget` 仍无人执行**：修完后它是"同值事实"（描述字段 = 实际上界），
  可留；但若将来引入边预算的**其它**语义（如 token 预算），要单独定夺，勿混进时长预算
- 7.2 **cluster 分支仍走自己的 `policy.timeoutMinutes`**：与 D2 优先级结论一致，故不改；
  若将来 cluster 的逐成员预算要独立于边预算，需另立规格
