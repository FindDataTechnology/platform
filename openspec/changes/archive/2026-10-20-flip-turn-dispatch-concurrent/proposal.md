# Flip TURN_DISPATCH to concurrent in production (flip-turn-dispatch-concurrent)

## Why

用户要「多个对话同时进行」。concurrent-chat-sessions 上产的是切窗不断流 + 排队；
真并行被 `queue` 默认压着，等待 dsh 侧证据。2026-10-20 两项实测把证据问题解决了：

1. **旧证据作废但引擎无罪**：2026-10-19 的「⑨b 5/5 PASS」被证实是空转绿（[HOLD] park
   的是标题生成 side call，会话回合从未被 park）；dummy 侧做诚实 ⑨b 需先建模 rc.2 的
   三类回合请求（会话/上下文维护/标题），未完成前 ⑨b 不能作为决策依据
   （dsh-matrix/README.md 2026-10-20 勘误）。
2. **真 cell 实验全绿**：生产 pod 内临时 cell（dsh 0.2.0-rc.2 + 真实 volces 路由，
   `TURN_DISPATCH=concurrent`）——对称 8/8 轮（双 agent_start 互相落在对方 done 之前、
   零 queued、零 error）+ 非对称 6/6 轮（短回合在长回合内开闭，即原始「收尾不交错」
   记录所指的形状）+ 收尾 sanity 通过。历史「非确定楔死」在当前引擎+真实 provider 上
   不再复现。

另一条路（升 dsh 0.2.1-rc.2）已被全量合同否决：8/17，④凭据热热重载真回归、⑫内部 API
变面、⑮delta lane 死——按矩阵纪律不能跟。

## What Changes

- **部署（本变更的实施面）**：platform 生产部署加 env `TURN_DISPATCH=concurrent` +
  `DSH_MATRIX_CLOSE_INTERLEAVE=1`（门闩，见 spec delta 的启用条件）。cell 由 gateway
  逐 spawn 继承，无需改代码/镜像。回滚=去 env（或 `TURN_DISPATCH=queue`）重启，分钟级。
- **spec**：`Dispatch policy is a deployment capability statement` 修改——启用条件从
  「⑨b 合同绿」改为「部署级运行时交错验证已记录」（合同 ⑨b 重建后仍首选；真 cell 实验
  协议为等价证据），代码默认仍 `queue` 直到 ⑨b 成为诚实门禁。
- **不改**：派发器代码、排队 UI（queue 策略仍是回滚面）、e2e/单测（各自固定策略）。

## Evidence

见 `notes/evidence.md`（两组实验原始输出、harness 勘误链、0.2.1-rc.2 否决记录）。

## Impact

- 用户：两个对话真同时出字；排队气泡不再出现（并发下自然不排队）。
- 风险：若生产长期运行中楔死复现，回滚面是纯 env；cron/bot 车道与 web 回合并发——
  cron-runner 的 waitForIdle/预约语义已按「忙=collectors+预约」实现（concurrent 策略
  下 dispatchTurn 直接派发，预约仍拦 cron 的 preset-switch 窗口）。
- 后续：重建 ⑨b 合同（三类请求建模）→ 若全绿，代码默认翻 concurrent 并撤生产 env。
