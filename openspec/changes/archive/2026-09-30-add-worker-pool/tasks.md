# Tasks: add-worker-pool

## 1. 引擎调度接缝

- [x] 1.1 `task-engine.js` 加 slot 派发钩子：到期执行先问池（worker 匹配→并发执行）；无池/池满→主槽串行链（今日语义原样） — 验证：单测——无池时行为与现状逐断言一致；有池时匹配任务不进串行链
- [x] 1.2 池满/cap0 时任务排队等待槽位释放（FIFO），不丢不重 — 验证：单测——cap=1 两任务先后执行、顺序确定

## 2. Worker 池核心

- [x] 2.1 `server/worker-slots.js`：`new DshBridge({...主槽参数, agentPreset: persona, onEvent: worker 泵})`，persona 终生绑定；共享组合 profile（决策 D1） — 验证：单测/冒烟——spawn 后 `presets/list` 报告绑定 persona
- [x] 2.2 Worker 事件泵：事件仅路由到该 worker 当前任务 session 的 collector（复用 collectTurn 契约）；bridge 退出中止在飞 collector（per-worker abort 注册表） — 验证：单测——stub 泵事件驱动 collector 完成
- [x] 2.3 Worker 执行循环：领取任务→busy→prompt 专属 session→collector 落库→结果回引擎 finishExecution（含 usage）→idle — 验证：单测——双 persona 并发执行互不阻塞
- [x] 2.4 空闲回收：60s 扫描、idle>5min 关停；busy 永不回收；后续任务冷启动 — 验证：单测——时钟注入断言回收与冷启
- [x] 2.5 cap 读取与守护：`TASK_WORKER_MAX`（默认 0）、非法值告警归 0 — 验证：单测——非法 env 回退 + 超限不 spawn

## 3. 汇总与观测

- [x] 3.1 aggregator 排空：注入前 await 池内在飞执行（D4），再走现有 waitForIdle/web 镜像 — 验证：单测——两个并发孩子终态后仅一次注回
- [x] 3.2 pool 状态广播：spawn/reap/busy/idle 发 `worker_pool` 事件（persona+state）；WS 类型与 store 落位 — 验证：单测——生命周期变化各发一事件

## 4. 配置与文档

- [x] 4.1 `.env.example` + `DEPLOY.md`：`TASK_WORKER_MAX`（fd-prod=0，演示机=3），k8s/deployment.yaml 显式置 0 — 验证：文档检视 + env 缺省回归
- [x] 4.2 现有 cron/delegation e2e 在默认（cap 0）下全部原样通过（行为保持门） — 验证：fast 套件绿

## 5. 收口验证

- [x] 5.1 自起服务器 worker e2e（subdir 隔离 store，`TASK_WORKER_MAX=2`）：双 persona 委派→两 running 并存→死 LLM 双 failed→汇总一次 — 验证：新 spec 绿
- [ ] 5.2 smoke（可选，网关有可用模型时）：真模型双任务并发 done + 汇总落回 — 验证：smoke spec 绿或注记网关阻塞
  - 状态注记（2026-10-01 补验关闭）：真模型（dots-studio free）自起服务器 TASK_WORKER_MAX=2 双长文委派——**running 重叠实测捕获**、双 worker 真实 spawn、汇总 turn 落回发起 session；两文被免费模型断流打断落 failed（与 MC 活测任务 7 同款），但并发机制 + 真模型 done 变体由 2026-10-01 MC 五任务活测（全 done，7.2k 字产出）分别证实——5.2 的验证实质完成
- [x] 5.3 `openspec validate add-worker-pool --strict` 通过；typecheck/lint/locales 全绿
