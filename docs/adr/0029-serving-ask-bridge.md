# ADR-0029: Serving asks ride the stream, answers ride a side route

- 日期：2026-10-21
- 状态：Accepted（change `add-serving-ask-bridge`）
- 关联：ADR-0012（user-questions 桥）、add-agent-notifications D1（notify 桥的先例）、fd-wanxing `add-copilot-control-surface`（姊妹 change，首个 opt-in 调用方）

## 背景

舰队 served child 由 `agent-runner/compose.js` 从四层 overlay 组合（presets → skills → MCP → notify），而 user-questions 桥只由 `dsh-profile.js` 写进 **cell** 的家。结果是任何 served agent 调 `ask_user_question` 都得到 NO_PROVIDER 工具错——问询能力在 serving 面根本不存在。E3 操控面（副驾 widget 的问询卡/宿主意图）以此为第一块地基。

## 决策

1. **桥的移植 = 再叠一层子类，而非改 SDK。** 新桥 `platform-serving-questions-bridge.js` 继承 notify 桥（NotifySdkServer），带上 cell 桥的 ask 正文（park + 上行通知 + first-wins + fallback timer）；`writeServingQuestionsPatch` 写 `serving-questions.patch.yml`（disable notify 行 + insert 自己）叠在 notify 之后。链：presets → notify → questions，一层一面。dsh SDK 与 child 侧零改动。

2. **传输 = 流上 `ask` 事件 + 侧路由 `POST /ask-answer`，否决 A2A `input-required` 拆回合。** 问询的 parked promise 活在 child 里，回合的 collector 与流 sink 活在发起该回合的请求处理器里；按 A2A input-required 拆成两请求，需要 manager 跨请求持有并移交流 sink，且第二个请求的响应要变成第一个回合的流尾巴——新状态、新失败模式、无已验证的腿。单条长连接 SSE 腿（delta 已验证可穿透 nginx/registry/逐字节 relay）+ 一个侧路由是最小增量。代价（挂一个连接与一个回合槽直到问询窗结束）由第 4 条封顶。

3. **opt-in 头 `X-Serving-Ask: 1`，未 opt-in 一律立即拒答。** 能否答题是**调用方传输**的属性（同一部署既有能答的萬星 facade 流，也有不能答的委派 cell / bot / `message/send`）。无 onAsk 的回合由 harness 统一快速拒答（cancel + reason），工具立刻得到「the caller cannot answer questions」——比今天的 NO_PROVIDER 更干净，旧调用方时序零变化。

4. **问询窗 = 剩余回合预算 − grace，harness 到期自取消。** 预算是墙钟、硬停（spec「Turn budgets are enforced with a hard stop」）不改：harness 在 deadline 主动 cancel 问询让 agent 体面收尾，-32001 只做兜底。人速等待的部署调大 `budgetMinutes`。否决「暂停预算钟」——它把计量与占用脱钩，邀请无界等待。

5. **心跳只在问询 pending 时发。** 问询期间每 15s 一条 SSE 注释帧（`SERVING_ASK_KEEPALIVE_MS` 可调）；答题路由或 deadline 后停。普通回合字节不变。

## 后果

- facade 侧无需为心跳做任何事（逐字节透传已覆盖）；答题的访客归属绑定在 facade 做（姊妹 change D1），runner 只认后端凭据。
- warm child 在镜像滚动前保持 NO_PROVIDER（overlay 只在冷启动/升级时物化）——与 notify overlay 的滚产语义相同。
- 未来若引入真正需要拆回合的长交互（如审批流），再评估 input-required；本 ADR 不阻塞它。
