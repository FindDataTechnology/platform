# restore-assistant-stream-020 — Design

## Context

0.2.0-rc.2 会话格式 v2 删除了 `assistant/chunk` 事件类型（运行时包零发射点，仅存于格式迁移包的旧名清单）；活流迁至进程内 `agent/assistant-stream` ctx 事件（dsh-agent-loop 逐帧 emit，session controller 的 follow API 以 `assistantStream:true` 订阅——上游自家用法即此）。宿主 dsh-events.js 监听死名，`assistant/message`（结算）只落库从不广播 → 网页对话直播期零正文（生产 sha-f7d7c39 起全量回归；刷新可见落库文本）。事件普查证据：2.2s 流式期间所有通知方法合计零事件，首条带正文事件为流结束后的 `assistant/message`。

既有可复用地基：platform-preset-bridge（子进程内插件）已有 `transportPeer.notify(method, params)` 子→宿通知通道（userQuestion/ask 同款）与 `platform/capabilities` 能力播报；dsh-events.js 的观众消息（`text`/`thinking`）与客户端契约无需动。

## Goals / Non-Goals

**Goals:**
- 0.2.0 运行时上恢复正文/思考的直播流（宿主↔客户端 WS 契约零变化）。
- 能力缺席时的诚实降级：结算正文恰好一次补发（chat-streaming 既有语义补齐实现）。
- cron 错误捕获、bot 流、trace 增量同源复活。
- dsh-contracts 新增流通道合同，钉住通道形状防代际跳版再断流。

**Non-Goals:**
- 后台续跑（切走不取消）——独立线（pod 方向），本变更不碰 `stopStreamingForSessionNavigation`。
- ZCode 式呈现打磨（ActivityGroup 折叠已备；正文恢复后呈现自然达标；用量行并入折叠头等小打磨另议）。
- 客户端（packages/core / web）任何改动。
- serving/A2A 线改造（走结算消息，未依赖 chunk）。

## Decisions

### D1 桥转发：`agent/assistant-stream` → `platform/stream` 通知（构造器注册）
platform-preset-bridge 的 Server 类**构造器**里 `ctx.on("agent/assistant-stream", ({ agent, frame }) => ...)`（入 `this.disposers`，与基类自家 session/event 监听同款形状），取 `agent.session.id` 作会话键，逐帧 `this.transport.notify("platform/stream", { sessionId, frame })`。帧词表即上游原样：`start` / `chunk`（StreamChunk 家族：block-start、text-delta、reasoning-delta、block-end、usage、finish——合同⑮实测词表）/ `end`——桥不做翻译，透传为准（词表变更由合同捕获，不由桥吸收）。
`platform/capabilities` 增播 `streamForward: true`。
**实施期定案（census 矩阵实验）**：`apply()` 的 `ctx.effect` 内注册（含 `{global:true}`）对这类 scope-filtered agent 事件**全聋**——同子进程同事件，构造器注册 12/12 命中、effect 注册 0/12。插件 ctx 的注册时机/作用域决定可达性；构造器注册是唯一实证可达的形状，已写进代码注释防回退。
**备选否决**：经 session controller 的 follow API 订阅（`assistantStream:true`）——那是给远端客户端的快照+流混合协议，宿主桥只需要裸帧；直听 ctx 事件最少层数、零快照语义。

### D2 宿主换源：dsh-events.js 收 `platform/stream`
通知层新增 `method === "platform/stream"` 分支（置于 collector 路由之后：web 会话进此分支，bot 会话的帧落入各自 collector——两车道同源一次接通）：`params.sessionId` 经既有 dsh↔web 会话映射得 `sid`；`start` 帧复位按段兜底标记；`frame.chunk.type === "text-delta"` → `sendToViewers(sid, {type:"text",delta})`、`"reasoning-delta"` → `{type:"thinking",delta}`、`finish && reason.kind === "error"` → `T.error` 捕获（沿 turn/end 播报路径）。删除死 `case "assistant/chunk"`——连带修掉其内部 `ctx.sendToViewers(ctx.dshSessionId, ...)` 的会话误绑（应一律 `sid`，与 turn/start、tool/call 对齐；这是潜伏错路由，不是新行为）。

### D3 结算兜底：按段恰好一次（streamedText 键控，不设能力门）
`assistant/message` case：当 `text && !T.streamedText` → `sendToViewers(sid, {type:"text", delta: 全文})` 一次性补发并置位；`platform/stream` 的 `start` 帧复位标记（一 attempt=一段），turn/start 亦复位。触发键是「本段是否真有 delta 到达观众」而非能力位——这正是 chat-streaming「exactly once + fallback」需求的字面语义：无 lane、lane 在但模型没流式（非流式响应）、多步回合里个别静默段，全部恰好补发一次；流式覆盖的段永不重复。补发走观众事件通道，天然进 turn buffer（断线重连重放同路，无特例）。能力位仅作观测面（capabilities/probe 报告）。

### D4 同源收口：cron / bots / trace / serving（实施期修正：serving 实际中枪）
- cron-runner.js：错误捕获从 chunk finish 改为 `platform/stream` finish-error 帧（同一 child 通知流）。tokens 记账已在 0cc933b 走 `assistant/message` usage，不动。
- bots.js：collector 增 `platform/stream` finish-error 捕获（bot 车道本就只吃结算文本）。
- trace.js：delta 帧照旧不落库（88% 字节教训维持），finish 帧落库且 `eventType="platform/stream"` 配摘要；历史行不受影响。
- **agent-runner/child.js（实施期发现）**：调研期「serving 走结算消息未依赖 chunk」判断错误——A2A 的 SSE `event: delta` 流式与 finish-error 结算（-32003）都吃 `assistant/chunk`，0.2.0 滚产后 serving 流式同样断了（被 -32005 空回合兜底掩盖）。同分支修复（test-agent-runner 4.3 用例守护）。

### D5 新合同：`assistant-stream-forward`（contracts.mjs）
以本变更的事件普查探针为骨架（慢速流式 dummy：6×300ms 文本增量）：断言 ①`platform/capabilities` 含流转发；②`platform/stream` 帧按序到达且帧词表/载荷家族形状匹配（start/text-delta…/end）；③双会话并发各流式时帧归属不串扰；④整轮 session.event 通知零 chunk 型增量（防上游复活双源时宿主静默漏评估）。合同编号接续在途 change `extend-dsh-contracts-020-capabilities`（其立项 ⑩-⑭；本合同 requirement 名与其零重叠，编号在实现时按彼时套件实际尾部顺延，design 不预占）。
**备选否决**：把断言并进合同⑨（多会话并发）——⑨的判据是收尾收敛语义，混入通道形状会让失败指因含混；独立合同失败一行讲清「通道变了」。

### D6 测试夹具
test-agent-runner 伪子进程改 emit `platform/stream`（含 finish-error 用例）；test-turn-error-broadcast、test-trace-store 的注入形状同步；dsh-events 的单测（如有）补降级分支用例（无能力位 + assistant/message 带文本 → 恰一次 text 补发；有能力位 → 不补发）。

## Risks / Trade-offs

- **监听载荷形状**：`{agent, frame}` 取自 session-controller 用法；若插件 ctx 层形状不同（仅 `{frame}`），实现时以桥内自证打点核对（合同④的插件激活门会兜住装错）。属实现核验点，非设计风险。
- **背压**：notify 逐行即发即弃，量级与 0.1.x chunk 持平（每 delta 一行），无新增风险；宿主端 sendToViewers 本就异步扇出。
- **帧 ordinal/revision 未转发**：session controller 的快照协议用 revision 合流；宿主桥不需要（无快照源）。若后续重连重放需要帧序修正，由 turn buffer 的既有事件序承担。
- **与在途 change 的 contracts.mjs 合流**：两个 change 都改合同套件文件；requirement 名零重叠，先归档者先入主 spec，后者归档时 `--specs` 校验合并（本份数已按此纪律预演）。工作树上若两 change 并行 apply，contracts.mjs 冲突面小（各自新增独立函数+表行）。
- **降级补发的重复风险**：恰好一次由 per-session `streamedText` 标记门控（turn/start 复位）；重连重放与补发都走观众事件通道，turn buffer 天然去序化风险与 0.1.x 时代相同，不新增面。
