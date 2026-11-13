# Tasks: wire-dsh-live-runtime-control

分两片交付：任务 1-4、6-7 为第一片（RPC 面 + 客户端，独立可发）；任务 5 为第二片（按会话状态，单独滚动）。

## 1. 桥侧自定义 RPC（dsh-profile-template/platform-preset-bridge）

- [x] 1.1 `model/set` 处理器：createSession 路径对 agentCtx 装 `installModelSelection`，ref 存会话记录；未带 sessionId 时更新新建默认。本地起真 dsh 子进程探针验证空闲活切 + 流中切换下一 step 生效（验证 installModelSelection 快照语义）
- [x] 1.2 `session/cancel` 处理器：`agent.cancel(cause)` + `whenIdle()` 收敛回执；探针验证取消后回合中止、会话可立即再收 prompt
- [x] 1.3 `tools/set` 处理器：经既有 guard 层翻会话级 MCP 服务器闸（默认关）；探针验证 A 会话开、B 会话仍拦（会话隔离）
- [x] 1.4 能力声明：桥名册应答携带 `capabilities: ["model/set","session/cancel","tools/set"]`；探针验证声明可见

## 2. 宿主桥接（dsh-bridge.js）

- [x] 2.1 新增 `setModel` / `cancelSession` / `setToolGate` 方法走 client.request；解析子进程能力声明存于桥实例。单测：能力解析 + 方法参数序列化
- [x] 2.2 降级：能力缺失时 setModel 返回「不支持」标记、cancelSession 返回 null，由调用方回落既有路径。单测覆盖新旧能力两种声明

## 3. 服务端接线（server/）

- [x] 3.1 `switchModelTo`：能力在→`model/set` 免重启（流中放行，去掉流中拒绝与 pendingConfig 禁发窗）；能力缺→既有 restart。e2e：流中 set_model 收 model_changed 且回合继续
- [x] 3.2 `stopStreamingForSessionNavigation` → `session/cancel`（去 restart）；WS 用户停止路径同改。e2e：流中切会话后新会话首条 prompt 立即可发（无重启窗口报错）
- [x] 3.3 联网开关 WS 协议（`set_tool_gate {server, enabled}`）→ 桥 `tools/set`；会话级状态存 chat-history 会话行或内存会话态。单测：默认关、开启只影响本会话、桥无能力时回错误提示
- [x] 3.4 `done` 载荷附加 usage：dsh-events 留存本回合最后 finish chunk 的 usage，finishTurn 附加发送。单测：有/无 usage 两态载荷形状

## 4. 客户端（packages/core + web/src）

- [x] 4.1 store：提交闭锁状态（发出→user 回显/超时）、canSend 纳入 isStreaming、usage 存储于回合、websearch 闸状态与 capabilities 订阅。单测：闭锁吞重复 prompt、done usage 落回合
- [x] 4.2 Composer/ControlStrip：联网开关芯片（默认关、无能力不渲染）+ Enter/点击提交走闭锁。e2e：Enter 键重复只出一条气泡；开关翻转即时生效
- [x] 4.3 AssistantTurn 用量脚注（in/out，无数据省略）+ 输入框旁 contextWindow 水位条（累计输入口径；无 contextWindow 不渲染；换模型重算）。e2e：完成回合显脚注与水位
- [x] 4.4 i18n：新增文案中英两份（开关名、pending、用量、水位 tooltip）

## 5. 第二片：按会话流状态（D4）

- [x] 5.1 `ctx.isStreaming`/`turnOrigin`/`turnBuffer` 全局态改按会话分键（Map + LRU 上界）。单测：两会话各自守卫独立
- [x] 5.2 prompt/steer 守卫、done/error 路由、broadcastSessions 按会话键取值。e2e：A 流中 B 可发可回（互不阻塞）
- [x] 5.3 回归：重连 resync、session-ownership、demo 配额在分键后全量 e2e 绿

## 6. dsh:contracts 活控制合同

- [x] 6.1 合同⑦（模型活切快照）、⑧（取消收敛）、⑨（多会话并发）实现并入套件；`npm run dsh:contracts` 全绿（缺省 scratch 树）

## 7. 验证与发布

- [x] 7.1 本地端到端冒烟：真 dsh 子进程 + web dev，五问题逐一手验（切模型即时、流中可切、开关默认关、脚注水位、无重复气泡、切会话即发）
- [x] 7.2 出片（模板+宿主+web 同滚）→ fd-prod 滚动 → 撤 `PACK_BASELINE_MCP` 中 websearch → 生产复验五点 + 观察错误率
  - sha-bd84e6f（快照=paas 377786c，platform-images 绕行线 6 分钟出片）生产 1/1 ready；GitOps 6bfbf3f 双动（镜像 tag + baseline 撤 websearch，各自独立可回滚）
  - 生产已验：web bundle 四标记（websearch/ctxHint/promptInFlight/sending）；容器内 bridge/scope 模板含 platform/capabilities+sessionGatedMcp；baseline 环境变量已撤；websearch 仍装在 owner profile（installed 服务器）但经 guard 会话闸默认关
  - 挂账已清（2026-10-14 上游恢复）：真回合探针五项 ALL PASS——usage {in:204,out:2}、活切 1ms、流中切会话 1ms、tools/set、capabilities。清账时暴露并修复 usage 形状错配（TokenUsage 挂 assistant/message 而非 finish chunk，0cc933b；cron-runner 同修），出片 sha-798332e 已滚生产（GitOps eb1903d）。探针自身 waitFor 历史匹配 bug 同修（waitForNext）。
  - 连带：/help e2e 用例漏更（10-11 帮助三 tab 化）补 reference tab 点击（d92588e），composer-stop 10/10
