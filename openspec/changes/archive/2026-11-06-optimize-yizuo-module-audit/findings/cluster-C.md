# 簇 C 体检报告 — chat·会话·记忆（33 spec）

> 审计日 2026-11-06；方法=五项检查（①spec-代码对齐 ②内容正确性 ③接口契约 ④可靠性 ⑤卫生）。
> 代码域锚点：web/src/App.tsx:303-428（路由权威）、web/src/pages+components、packages/core/src（ws 协议类型 + chat-store）、server.js/server/*.js（server.js、chat-history.js、cell-memory.js、memory-discipline.js 在仓根）、gateway/（share/zhiyu/wanxing）。
> 特别说明：fd-memory（记忆服务本体，/digest、/pages、/memory、/hook、/distill、/embed、forget、tier 提议引擎）在**独立服务仓**，本仓只有消费端/代理端代码。簇内 8 条 memory 类 spec 的服务端实现无法在本仓断言，按消费端锚点核对并在评级中注明。

## 判定总表

| # | spec | reqs | 评级 | 一句话判定（关键证据） |
|---|---|---|---|---|
| 1 | agent-memory-foundation | 5 | **B** | Purpose 是归档机 TBD 占位（spec.md:4，已确认）；契约实现在 fd-memory 服务仓，本仓仅消费端（cell-memory.js:83-103 oversight 锚点、fleet-memory.js:132 /pages POST 带 metadata） |
| 2 | chat-activity-collapse | 5 | A | ActivityGroup.tsx:55-61 组开合+待确认自动展开；ToolBlock.tsx:126 `endsWith("__propose_action")` 后缀匹配；miniapp/src/components/TurnView.tsx、OutlineRail.tsx 双面在场 |
| 3 | chat-attachments | 3 | A | server/routes/documents.js:38-48 原件随摄入落 uploads、:79-86 随文档删除；server/ws.js:534,627 `@doc:<id>` 展开 |
| 4 | chat-chart-rendering | 6 | A | Markdown.tsx:172 echarts fence、:181-224 库徽章 `chart-library-badge`→/resources；EChart.tsx:23-26 动态 import 懒加载 |
| 5 | chat-commands | 4 | A | Composer.tsx:4,63-65 `/clear`/`/help` 客户端处理；server/agent-session.js:796,805 `command_use`；SlashCommandPicker.tsx |
| 6 | chat-composer-controls | 10 | A- | ControlStrip.tsx：model/set 活切（:17,350）、tools/set 联网芯片（:517-541）、reasoningEfforts 门（:372）、`max-md:text-base` 16px（:639）；set_agent 流中拒绝 server/agent-session.js:464-466；AssistantPicker.tsx:235 流中禁用。瑕：Req7/8 仍以「条上的 agent control」行文，未点名控制已迁「与谁对话」 |
| 7 | chat-connect-guidance | 2 | A | server/connect-guidance.js:32（模型车道→ciyuan-account）、:59-62（credential-ref→panel）；ConnectCta.tsx:19 深链 settings connections?panel= |
| 8 | chat-history | 11 | A | chat-history.js:145,161-169 owner/workspace 首回合盖章、:180-188 functional-ref 归一；server/routes/chat-history.js；重建工具 scripts/rebuild-chat-index.mjs + check-rebuild-parity.mjs |
| 9 | chat-input-focus | 1 | **C** | 唯一 requirement 在现网代码不可达：Composer 仅 focusTick（预填卡/搁草稿）触发聚焦（Composer.tsx:260-264、ChatPage.tsx:170-187）；New chat 按钮（Sidebar.tsx:697-704）与 `/new`（服务端 command_use）均无聚焦路径；e2e 无对应断言 |
| 10 | chat-memory | 6 | A | server/cluster-memory.js:157-191 chat 车道+`CELL_MEMORY_CHAT_DIGEST=0` 零行为；:25 默认 9000ms>8000 embed 预算；k/budget 共用 env（:125-126）；`chatMemoryBlockFor`（:173-181）被智语房间回合消费（gateway/zhiyu/index.js:73）——Req6 有实锚；memory-discipline.js 单一来源，cell-memory.js+dsh-profile.js 双面 |
| 11 | chat-outline-navigation | 4 | A | Chat.tsx:23 `OUTLINE_MIN_USER_TURNS=3`；ChatOutline.tsx 悬停展开/jump；miniapp/src/components/OutlineRail.tsx |
| 12 | chat-plan-progress | 6 | A | server/dsh-events.js:696-711 todo/write→todos（sendToViewers）；:153-162,708 按会话缓存+重连推快照；PlanPanel.tsx |
| 13 | chat-streaming | 13 | A- | dsh-events.js:527-538 用量、:543-554 settled-text 恰一次回退、:235 done 恰一次；packages/core/src/store/chat-store.ts:1230 重连按 running 三分支；ws.js:762 `session/cancel` 真取消；ws.ts types queued/dequeued/stop_turn。瑕：「steer」scenario 行文与现网拒绝路径（ws.js:129-135,177-178 busyMessage error）不符——requirement 正文「steer/reject branch」已兜住，仅 scenario 措辞滞后 |
| 14 | chat-ui-shell | 11 | A- | App.tsx:304 `/`→/chat；package.json:33 postinstall；后端 buildless 仍真。瑕：spec.md:65 模块清单含 `mcp-bridge.js`——该文件已于 630804fb（migrate-pi-to-dsh）删除 |
| 15 | chat-usage-display | 3 | A | dsh-events.js:233-236 done 附 `usage`、:527-538 取最后一步 assistant/message 的 data.usage；ControlStrip.tsx:358-368 contextWindow 水位；AssistantTurn.tsx:300 脚注 |
| 16 | chat-welcome-state | 3 | A- | ChatWelcome.tsx:46 RECENT_PREVIEW=5、:171-183 view-all 展开——超出 spec「最近 5 条」的加项未回写 spec；greeting/4 卡/IntentOnboarding（:125）齐 |
| 17 | memory-digest-embed-lane | 5 | A- | 预算/采样纪律在 fd-memory 仓（外部）；本仓可验的调用方不变量成立：cluster-memory.js:25 默认 9000ms 且注释（:62-66）明写「必须大于 8000 embed 预算」 |
| 18 | memory-distiller | 9 | B | 全部实现（sidecar /distill、/embed、Hy-Memory pin、cursor 纪律）在 fd-memory 仓，本仓零锚点可核；spec 文本自洽且精确——有债（跨仓不可证）不误导 |
| 19 | memory-eval | 7 | B | 评测 harness 与 continue-baseline 落档全在 fd-memory 仓；本仓 grep 无 continue-baseline。同上跨仓不可证 |
| 20 | memory-federation | 4 | A- | 本仓侧全对齐：cluster 车道 digest 挂点 cluster-memory.js:68（k=5/budget=1500 默认=spec）、:125-126 env 覆盖、三档降级 :102-121；纪律文案单一来源（memory-discipline.js）。/hook、platform 令牌铸造面在 fd-memory 仓 |
| 21 | memory-portal-ui | 6 | A- | MemoryPage.tsx：漏斗（:87-150 memory-funnel）、晋升箱（:29 promotions）、tier 筛、memory_unavailable 降级态；server/routes/memory.js:21-118 person 代理+promotions 手势+:119 deployer-entries。萬星 console 入口 UI 在外部仓 |
| 22 | memory-surface-hardening | 4 | B | /digest 边界、tier/tag 写面拒绝、向量规模指标全在 fd-memory 仓；本仓无可核锚点（调用方仅受益方） |
| 23 | memory-tier-promotion | 4 | A- | server/routes/memory.js:58-118 accept/ignore 手势（人批）；MemoryPage.tsx:29 晋升箱；AI 提议引擎侧在 fd-memory 仓 |
| 24 | memory-visibility | 3 | A- | /api/memory/entries 代理（server/routes/memory.js:21-60）：person 令牌、scope/layer/tier/tag/time、分页，与 spec 筛选语义一致；forget/平台缝 rootKey 读面在 fd-memory 仓 |
| 25 | session-list-management | 5 | A | ChatSessionMenu.tsx:51-62 running/queued 禁删+tooltip、:210 非活跃禁 Clear、:240 `session-save-solution`；Sidebar.tsx:1046 Shift+F10 |
| 26 | session-ownership | 5 | A | chat-history.js:243-319 owner scope/403 语义；server/ws.js 按连接可见性发 sessions；dsh-events.js:711 sendToViewers |
| 27 | session-share | 6 | A | gateway/share.js:39 `randomBytes(18)`=144bit≥128、:93-97 30/min 限速；gateway/index.js:717-753 POST/GET/DELETE /api/share(+/:token)；App.tsx:215-220 /share 免登录豁免；SharePage.tsx |
| 28 | session-solution-capture | 3 | A | SessionToPresetDialog.tsx:38 200 字上限、:143-174 examples≤3、PUT 更新/POST 创建分轨；ChatSessionMenu.tsx:240 testid |
| 29 | turn-dispatch | 9 | A | server/turn-dispatch.js:31-42 TURN_DISPATCH/concurrent 需 DSH_MATRIX_CLOSE_INTERLEAVE=1、:58 TURN_QUEUE_MAX=8、:191 queue_full；server.js+dsh-events.js 接线；生产 2026-10-20 翻转证据入 spec 文本 |
| 30 | turn-tracing | 5 | A | server/trace.js:61 TRACE_RETENTION_DAYS=7、:159 auto_vacuum=INCREMENTAL、独立 trace.db；server/routes/trace.js:23,55；App.tsx:324-325 /trace→settings 诊断 + /trace/:turnId 顶层保留 |
| 31 | zhiyu-im-bridge | 6 | A- | server/routes/zhiyu-im-bridge.js:32-65 GET/PUT/DELETE 绑定（同形 404）；BotsPage.tsx:430 RoomBindingSection 挂接面；gateway/zhiyu/im-bridge.js 回写。瑕：spec REST 路径写作 `/api/zhiyu/im-bridge/bots/:id/room`（spec.md:11），代码实为 `/api/zhiyu-im-bridge/bots/:id/room`——契约文档路径错误 |
| 32 | zhiyu-room | 11 | A | gateway/zhiyu/room-router.js:35 「过」pass 标记、:239-248 effectiveCap 两级上限+reply_cap_hit 事件；index.js:378-383 dailyBudgetTurns 1..100000、:364-367 升房 hatch（sessionId+窗口经 cellExport）；web ZhiyuPage/ZhiyuRoomPage |
| 33 | zhiyu-widget | 9 | A | gateway/zhiyu/index.js:844 snippet 格式逐字符同 spec、:1011-1025 /zhiyu/widget.js + frame-ancestors 动态白名单；guest-auth.js HMAC identify；web/src/pages/ZhiyuEmbedPage.tsx |

**分布：A×18、A-×10、B×4、C×1、D×0。** 簇整体健康度高：协议类（chat-streaming/turn-dispatch/session-*/turn-tracing）与代码严丝合缝到 file:line；UI 类组件齐、testid 与 spec 一致。

## B 级展开（有债不误导）

### agent-memory-foundation（B）
- **卫生（已知项，确认）**：`openspec/specs/agent-memory-foundation/spec.md:4` = `TBD - created by archiving change add-agent-memory-foundation. Update Purpose after archive.` 归档机占位未回填。5 条 requirement 本身完整（metadata 写读/回填/owner 监督/memory_overview），内容自洽。
- **归属**：spec 的实现权威在 fd-memory 服务仓（`/pages` POST metadata、`/digest` 筛选、`memory_overview` MCP 工具、存量回填命令）。本仓全仓 grep `memory_overview` 零命中；paas 侧可证锚点只有消费端：fleet-memory.js:131-139（/pages POST 已带 metadata 参数）、cell-memory.js:83-103（owner 绑定即 oversight 锚点）。
- 不误导：spec 无任何与 paas 代码相矛盾的断言；风险仅在「读者以为实现在本仓」。

### memory-distiller（B）/ memory-eval（B）/ memory-surface-hardening（B）
- 三条同为 fd-memory 服务仓契约：蒸馏 sidecar（/distill、/embed、Hy-Memory pin、subject 双路判定、向量候选检索）、三臂评测 harness（continue-baseline 落档）、/digest 输入边界与向量规模指标，本仓均无实现可核（grep `continue-baseline` 在 scripts/ test/ 零命中）。
- 本仓可证的间接锚点全部成立且与 spec 不变量互相咬合：cluster-memory.js:25 调用方超时默认 9000ms > fd-memory embed 预算上限 8000ms（digest-embed-lane Req4 的调用方侧），且 fleet-memory.js:23 复用同一 `digestTimeoutMs`——「chat 与集群同一超时」在两条车道上都是同一函数。
- 债的性质：ledger 的「代码域」列若不注明 fd-memory 仓，后续体检/修复轮会在 paas 仓里空找实现。属登记性债务。

## C 级展开（能力悬空）

### chat-input-focus（C）
- spec（全文 17 行）唯一 requirement：「The chat UI SHALL focus the chat input textarea when a new session is created, either by clicking the "New chat" button or executing the `/new` command」，两个 scenario 分别钉 New chat 按钮与 /new。
- 现网代码无任一路径兑现：
  - Composer 的聚焦机制只有 `focusTick`，而 ChatPage 仅在 suggested-prompt 预填与跨页搁草稿时 bump（ChatPage.tsx:170-187；Composer.tsx:260-264）。
  - New chat 按钮只 `navigate("/chat") + send({type:"new_session"})`，无聚焦调用（Sidebar.tsx:697-704）。
  - `/new` 为服务端处理（agent-session.js command_use），客户端无对应聚焦分支；全 `web/src` 对 ChatPage/Sidebar 的 `.focus()` 检索为零命中，chat store 无 focus 概念。
  - e2e（chat-polish.spec.js）大量点击 new-chat-btn，但只断言 welcome/卡片可见，无 focus 断言。
- 判 C 的依据：1-req spec 的全部能力在代码中不可达（要么从未落地、要么在某次重构如双分支 Composer 挂载中丢失）。修复面极小（new_session 派发后 bump focusTick / server 端 `/new` command_use 后客户端聚焦），建议随修复 change 顺带补 e2e 断言。

## 本簇 P0/P1/P2 候选

**P0**（无）
- 簇内未发现与代码矛盾且会误导实现的协议契约、安全回归或数据丢失项。

**P1**
1. `chat-input-focus` 能力悬空（C）——补聚焦行为或降 spec；小面高性价比。
2. `agent-memory-foundation` Purpose TBD（spec.md:4）——归档机回填（与全局 5 处 TBD 同一轮）。
3. `zhiyu-im-bridge` spec.md:11 REST 路径笔误：`/api/zhiyu/im-bridge/bots/:botId/room` → 实际 `/api/zhiyu-im-bridge/bots/:botId/room`（server/routes/zhiyu-im-bridge.js:32-65）。按 spec 路径写集成方会 404，属接口契约文档错误。
4. `chat-streaming` steer scenario 措辞回写：同会话流中二次 prompt 现网为 `error`（"The agent is still responding"，ws.js:129-135,177-178），非「forwarded with steer behavior」；requirement 正文「steer/reject branch」二选一已兜住语义，scenario 应改为 reject 形状（agent-session.js:646 注释也自证「rejected instead of steered」）。

**P2**
1. `chat-ui-shell` spec.md:65 后端模块清单刷新：`mcp-bridge.js` 已随 migrate-pi-to-dsh（630804fb）删除；「backend remains buildless」结论仍真，但点名文件列表失真。
2. `chat-welcome-state` 回写 view-all 加项：ChatWelcome.tsx:171-183 的「查看全部」超出现 spec 的「last 5」表述（RECENT_PREVIEW=5 仍守约）。
3. `chat-composer-controls` Req7/8 主语更新：agent control 已迁「与谁对话」（AssistantPicker），req 行文仍以「the agent control / strip」叙述（Requirement 1 已注明 retired，前后不自洽）。
4. ledger 回填时为本簇 5 条跨仓 spec（agent-memory-foundation、memory-distiller、memory-eval、memory-surface-hardening、memory-digest-embed-lane 的服务端半边）标注代码域=fd-memory 服务仓，避免下轮体检空转。
5. `memory-portal-ui` Req2（萬星 console 部署者入口）的 console UI 在外部仓，paas 侧仅 `/api/memory/deployer-entries` 代理在场——ledger 注明半边归属即可。
