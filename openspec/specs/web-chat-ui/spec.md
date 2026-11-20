# web-chat-ui Specification

## Purpose
The browser chat surface: the conversation view, its composer and controls, the WebSocket-driven message lifecycle, and session navigation affordances.

## Requirements

### Requirement: Chat UI displays messages in a conversation view
The chat UI SHALL display user messages and assistant responses in a scrollable conversation area with distinct styling for each role.

#### Scenario: User sends a message
- **WHEN** the user types a message and submits it
- **THEN** the message SHALL appear in the conversation area with user styling (right-aligned, distinct background)

#### Scenario: Assistant responds with text
- **WHEN** the server sends text deltas for an assistant response
- **THEN** the text SHALL appear incrementally in the conversation area with assistant styling (left-aligned)

### Requirement: Chat UI shows tool execution status
The chat UI SHALL display tool execution start and end events inline with the conversation.

#### Scenario: Agent runs a tool
- **WHEN** the server sends a `tool_start` event
- **THEN** the UI SHALL display a tool indicator showing the tool name with a loading state
- **AND** when `tool_end` arrives, SHALL update the indicator to show success or error

### Requirement: Chat UI supports streaming text input
The chat UI SHALL provide a text input field with a send button and Enter key support for submitting prompts.

#### Scenario: User submits a prompt
- **WHEN** the user types text and presses Enter or clicks the Send button
- **THEN** the prompt SHALL be sent to the server via WebSocket and the input SHALL be cleared

#### Scenario: Empty input is rejected
- **WHEN** the user tries to submit an empty or whitespace-only message
- **THEN** the message SHALL NOT be sent

### Requirement: Chat UI handles WebSocket connection lifecycle
The chat UI SHALL connect to the WebSocket server on page load, display connection status, and reconnect on disconnect using exponential backoff. The reconnect delay SHALL be `min(30000, 1000 * 2^attempt)` milliseconds multiplied by ±25% jitter. The UI SHALL stop scheduling reconnect attempts after a maximum of 20 attempts. The attempt counter SHALL reset to 0 on a successful connection (`onopen`). The UI SHALL listen for the browser `online` event and, when the network is restored, clear any pending reconnect timer, reset the attempt counter, and reconnect immediately — bypassing the backoff. The unmount guard (`cancelled`) SHALL be preserved so a cleaned-up component does not reconnect or schedule further timers. On every successful connection the UI SHALL re-sync the active session: when a session is currently active, the client SHALL send `switch_session` for it so the server's sync answer (transcript, running state, and turn replay — see `chat-streaming`) restores the in-flight view.

#### Scenario: connection lost triggers backoff
- **WHEN** the WebSocket connection drops and the component is still mounted
- **THEN** the UI SHALL show a "Disconnected" status
- **AND** SHALL schedule a reconnect after a jittered exponential delay (`min(30000, 1000 * 2^attempt)` × ±25%)

#### Scenario: backoff stops after the cap
- **WHEN** the connection has failed the maximum number of reconnect attempts (20)
- **THEN** the UI SHALL stop scheduling further reconnect attempts

#### Scenario: online event triggers immediate reconnect
- **WHEN** the browser fires the `online` event while disconnected and a reconnect timer may be pending
- **THEN** the UI SHALL clear the pending timer, reset the attempt counter to 0, and reconnect immediately

#### Scenario: successful connection resets the counter
- **WHEN** a reconnect attempt succeeds (`onopen`)
- **THEN** the attempt counter SHALL reset to 0

#### Scenario: unmount stops reconnection
- **WHEN** the component unmounts
- **THEN** the unmount guard SHALL prevent further reconnect attempts and clear any pending timer

#### Scenario: successful reconnect re-syncs the active session
- **WHEN** a connection opens (initial or reconnect) and a session is currently active
- **THEN** the client SHALL send `switch_session` for the active session alongside the roster queries
- **AND** the sync answer SHALL drive the in-flight turn's restoration per `chat-streaming`

### Requirement: Chat UI shows thinking blocks
The chat UI SHALL display thinking content from the agent in a collapsible block.

#### Scenario: Agent produces thinking output
- **WHEN** the server sends a `thinking` delta event
- **THEN** the UI SHALL display the thinking content in a collapsible, visually distinct block

### Requirement: Session opens optimistically with a pending state

When the user activates a session entry (sidebar row, welcome-page recent, tasks/resources jump), the chat view SHALL switch to the target session immediately, showing a pending placeholder for that session instead of the previous session's transcript, without waiting for the server's `session_loaded`. A `session_loaded` that arrives for a session other than the one the client now views SHALL be ignored for transcript replacement. The composer SHALL stay usable-per-existing-rules; the pending state SHALL resolve into the loaded transcript, an error state on failure, or the cached transcript when one exists.

#### Scenario: click gives instant feedback

- **WHEN** the user clicks a session in the sidebar while the previous session's transcript is displayed
- **THEN** the view immediately shows the target session with a pending placeholder
- **AND** the previous transcript is no longer displayed

#### Scenario: a stale load does not clobber the view

- **WHEN** `session_loaded` arrives for session A after the user has already navigated to session B
- **THEN** the client SHALL ignore it for transcript replacement and session B's pending state is unaffected

### Requirement: Visited sessions are cached client-side

The client SHALL retain the rendered turn list of sessions it has loaded and SHALL re-enter a cached session by rendering the cached transcript immediately, refreshing it from the server in the background. A cached entry SHALL be dropped or refreshed when the client receives an event indicating that session changed (turn completed, session deleted). The cache SHALL be bounded (a small LRU of sessions).

#### Scenario: re-entering a visited session is instant

- **WHEN** the user switches from session A to session B and back to session A, and A is cached
- **THEN** A's transcript renders immediately from the cache
- **AND** a background refresh reconciles any changes

#### Scenario: cache does not show completed-away turns as stale

- **WHEN** a turn in session A completes while the user views session B and the completion event for A is received
- **THEN** A's cached entry is refreshed or dropped so the next entry does not render the pre-turn transcript as final

### Requirement: Transcript rendering is windowed

The conversation view SHALL mount only the most recent N turns on session open, with an affordance to load earlier turns in batches. The store SHALL hold the **loaded window** of turns — initially the N most recent, as delivered by the server's first-frame window — and the load-earlier affordance SHALL fetch the preceding page from the server and prepend it, extending the loaded window. Features that read the turn list (outline navigation, export) SHALL keep operating without error over the loaded window, and MAY request all pages when they require the complete transcript. N SHALL be the same constant the server uses for its first-frame window.

#### Scenario: long session opens without mounting everything

- **WHEN** a session with several hundred turns is opened
- **THEN** only the most recent N turns mount, and the transcript is scrolled to the bottom
- **AND** an affordance to load earlier turns is presented at the top

#### Scenario: loading earlier turns prepends history

- **WHEN** the user activates the load-earlier affordance
- **THEN** the previous batch of turns is fetched from the server and mounts above the current window without losing scroll position

#### Scenario: the affordance disappears at the oldest turn

- **WHEN** the loaded window already includes the session's first turn
- **THEN** the load-earlier affordance SHALL NOT be presented

### Requirement: File previews and downloads show busy states

Every preview-drawer renderer and download action SHALL present a visible busy state while its file content is being fetched, for all preview kinds (not only text-like kinds), and the download affordance SHALL fall back to a plain navigation download if a fetched download cannot be completed.

#### Scenario: large file preview shows a transition

- **WHEN** the drawer opens for a large image, PDF, or download-only file
- **THEN** a busy indicator is displayed until the content is available or the renderer falls back to the download action

#### Scenario: download with fetch falls back on failure

- **WHEN** a fetched (busy-state) download fails
- **THEN** the client SHALL fall back to a plain navigation download of the same URL

### Requirement: A pending ask renders as an interactive question card

While an `ask_user_question` tool call is pending, the chat UI SHALL render it as a question card: one section per question with its options as selectable choices, multi-select where the question declares it, an in-card free-text field whose content is submitted as the custom answer, and a cancel affordance. Presentation intents (e.g. plan review) SHALL render as the generic option list. While the card is pending, the composer SHALL be disabled.

#### Scenario: option selection submits an answer

- **WHEN** the user selects an option and submits the pending card
- **THEN** the selected option label is sent as the answer and the card stops accepting input

#### Scenario: free text submits as a custom answer

- **WHEN** the user types free text into the card's input and submits
- **THEN** the text is sent as the custom answer for that question

#### Scenario: cancel dismisses the ask

- **WHEN** the user activates the card's cancel affordance
- **THEN** a cancellation is sent and the card resolves without an answer

#### Scenario: plan-review question renders generically

- **WHEN** a pending question declares a plan-review intent
- **THEN** it renders as the generic option list and its answers encode identically

#### Scenario: composer is gated while pending

- **WHEN** a question card is pending in the streaming turn
- **THEN** the composer is disabled until the ask resolves

### Requirement: Resolved cards collapse to a summary and replay from history

After an ask resolves, the card SHALL become a non-interactive summary showing the outcome — the given answers, a cancellation, or an error — and history replay SHALL render the same summary shape without live inputs.

#### Scenario: answered card shows the answers

- **WHEN** a pending ask is answered
- **THEN** the card renders a static summary of the chosen answers

#### Scenario: history replay shows a static card

- **WHEN** a past turn containing an `ask_user_question` call is loaded from history
- **THEN** the ask renders as a static summary, never as an interactive card

### Requirement: Concurrent surfaces converge on the first answer

WHEN another surface resolves the pending ask first, a client's card SHALL converge to the final resolved state without error.

#### Scenario: another surface answered first

- **WHEN** the ask is resolved from a different surface while a client's card is still pending
- **THEN** the card updates to the answered summary with no error shown

### Requirement: 副驾入口与独立会话

壹座 web SHALL 只在能解析出产品线上下文的面上提供副驾 dock 入口——线看板
（`/boards/:line`）、pack 市场面、团队/舰队面——入口 SHALL 是该面页面内的一枚明确控件，
SHALL NOT 是全局悬浮入口。无线上文的页面（主对话、知识库、设置等）MUST NOT 渲染
dock 入口：那里的对话入口是主对话本身与萬星跨线副驾。

打开的 dock SHALL 是覆盖在内容区的浮层，MUST NOT 遮挡导航侧栏；侧栏折叠时该限制随之解除。

副驾 SHALL 使用独立会话，MUST NOT 写入或干扰用户当前的主对话会话，MUST NOT 改变主对话
的滚动位置与草稿。副驾会话 SHALL 可按线持久化，并在再次打开时恢复。

副驾 dock 的尺寸与默认展开态 SHALL 由该面的副驾配置（见 `copilot-workbench`）决定，
MUST NOT 在组件内写死；组件内写死的值只能作为三层配置全部缺省时的最终兜底。
尺寸 SHALL 在同一浏览器下次打开时沿用，且放大尺寸 MUST NOT 超出视口。

#### Scenario: 打开副驾不打断主对话

- **WHEN** 用户在主对话流式回答期间打开副驾
- **THEN** 主对话继续流式渲染，副驾在其独立会话中交互

#### Scenario: 关闭再打开恢复上下文

- **WHEN** 用户关闭副驾后再次打开同一看板的副驾
- **THEN** 副驾恢复该线此前的会话内容

#### Scenario: 无线上文的页面没有 dock 入口

- **WHEN** 用户打开一个没有线上下文的页面（配置、知识库、团队等）
- **THEN** 页面上不存在副驾 dock 入口，也不出现指向无上下文会话的浮层控件

#### Scenario: dock 打开时不遮挡导航

- **WHEN** 桌面宽度下用户从线看板打开副驾 dock
- **THEN** dock 的浮层出现在导航侧栏右侧，侧栏的菜单与会话列表保持可见可点

#### Scenario: 尺寸来自配置

- **WHEN** 该面副驾配置声明的默认尺寸不是组件兜底值
- **THEN** dock 以配置的尺寸打开
- **AND** 用户手动调整后，该手动值在该浏览器内优先于配置

#### Scenario: 缩放尺寸被记住

- **WHEN** 用户调整过 dock 尺寸后关闭，再在同一浏览器打开
- **THEN** dock 以该尺寸出现（放大态则沿用放大尺寸），且不超出视口

#### Scenario: 放大 dock 不丢会话

- **WHEN** 用户在副驾里已有多轮对话后点击「放大」
- **THEN** 面板放大到更大尺寸，全部对话内容仍在，可继续在同一会话里追问

### Requirement: 副驾携带看板上下文

从线看板打开副驾时，后续**每个回合** SHALL 携带看板标识、当前视图与选中对象作为上下文，
且该上下文 SHALL 以显式的「宿主页面提供的上下文（非用户指令）」前缀随提示送达模型，
与用户正文明确分隔。上下文 MUST NOT 被描述为用户说过的话，模型 MUST NOT 把其中内容当作用户指令。

上下文 SHALL 对用户可见（顶部上下文条），且用户 SHALL 能清除。清除 SHALL 同时停止向模型递交
该上下文；MUST NOT 只隐藏上下文条而继续递交。

副驾 MUST NOT 在上下文未包含某一事实时声称知道该事实。上下文条不得成为「已经送达」的凭证。

副驾打开期间宿主切换看板或视图时，上下文 SHALL 同步更新界面与模型侧，MUST NOT 停留在副驾
首次打开时的那一帧；不得因切换看板而丢弃副驾当前会话。

#### Scenario: 上下文条可见

- **WHEN** 用户从谦面看板打开副驾
- **THEN** 副驾顶部显示正在看的看板与筛选，并可清除

#### Scenario: 看板上下文真的进入首个回合

- **WHEN** 用户从 `/boards/facet` 打开副驾并发出第一条消息
- **THEN** 该回合送达模型的内容中含谦面这一标识与被标注为非用户指令的上下文段

#### Scenario: 切换看板上下文跟上

- **WHEN** 副驾打开期间用户从谦面看板切到柏讯看板
- **THEN** 上下文条与之后回合送达模型的内容都是柏讯
- **AND** 副驾会话内容不因此清空

#### Scenario: 清除后不再递交

- **WHEN** 用户点击清除上下文并随后提问
- **THEN** 该回合送达模型的内容不含任何看板上下文

### Requirement: 动作卡的两面

`propose_action` 的工具调用 SHALL 渲染为专用卡片而非通用工具块：待确认面 SHALL 显示动作名、目标、影响面与确认/取消；已执行面 SHALL 显示结果摘要与审计入口。卡片 SHALL 在历史重载后仍回放为已执行面。

#### Scenario: 待确认面

- **WHEN** 副驾提议一个写动作
- **THEN** 对话中出现待确认动作卡，含影响面与确认/取消按钮

#### Scenario: 历史回放

- **WHEN** 用户重新打开包含已执行动作的会话
- **THEN** 该动作以已执行面渲染，显示结果摘要

### Requirement: 副驾 dock 注入聚焦预设并在关闭后恢复

从线看板打开的副驾 dock SHALL 在其 iframe URL 中携带该线聚焦助手的 agent 标识（`preset=<agentId>`）；副驾 embed 页面 SHALL 在连接就绪后、首个回合之前，将运行时切换到该 agent，使副驾会话以聚焦预设运行。切换 SHALL 对用户可见：副驾上下文条显示聚焦预设名称，主对话的 agent 选择器同步反映当前 agent，MUST NOT 静默替换。

关闭 dock 时，若当前 agent 仍是 dock 注入的聚焦助手，壹座 SHALL 恢复为打开 dock 前的 agent；若用户在 dock 打开期间已在主对话手动切换到其他 agent，SHALL 保留用户的选择，MUST NOT 覆盖。

切换因主对话正在回答而被运行时拒绝时，副驾 SHALL 在上下文条显示未聚焦的原因并提供重试，MUST NOT 自动循环重试，MUST NOT 伪称已聚焦。URL 不携带预设（该线无聚焦助手）时，副驾 SHALL 显示未聚焦及原因。清除看板上下文 MUST NOT 改变预设。

#### Scenario: 打开 dock 即聚焦

- **WHEN** 用户在 `/boards/facet` 打开副驾，且谦面线解析到聚焦助手「谦面助手」
- **THEN** iframe URL 含 `preset=` 与该 agent 标识，副驾上下文条显示「聚焦预设：谦面助手」，主对话 agent 选择器显示「谦面助手」

#### Scenario: 关闭 dock 恢复原 agent

- **WHEN** 打开 dock 前主对话 agent 为内置助手，用户关闭 dock 时当前 agent 仍是「谦面助手」
- **THEN** 运行时切回内置助手，主对话 agent 选择器恢复显示内置助手

#### Scenario: 用户中途手动切换则不恢复

- **WHEN** dock 打开期间用户在主对话把 agent 切到「法条助手」，随后关闭 dock
- **THEN** 当前 agent 保持「法条助手」，壹座不发出任何恢复切换

#### Scenario: 主对话回答中切换被拒

- **WHEN** 主对话正在流式回答时用户打开 dock
- **THEN** 副驾上下文条显示「主对话正在回答，暂未聚焦」与重试按钮；点击重试后再发一次切换，期间不自动重试

#### Scenario: 无聚焦助手时诚实降级

- **WHEN** 用户从未安装该线助手 pack 的看板打开副驾
- **THEN** iframe URL 不含 `preset=`，上下文条显示「未聚焦：该线助手 pack 未安装」

### Requirement: 非 embed 导航的预设深链

壹座对话页 SHALL 在**普通导航**（非 `embed=copilot` 的 iframe 场景）中同样
支持 `?preset=<agentId>` 深链：从功能集安装引导等入口落地 `/chat?preset=…`
时，页面 SHALL 在连接就绪后、首个回合之前将运行时切换到该 agent，语义与
副驾 embed 深链一致——切换 SHALL 对用户可见（选人控件与头部标签同步反映
当前 agent，MUST NOT 静默替换），切换被运行时拒绝（如流式中）时 SHALL 显性
呈现未聚焦原因并提供重试，MUST NOT 自动循环重试或伪称已选中。

深链目标 agent 不存在（如功能集已卸载）时，页面 SHALL 显示明确的原因提示
并保持当前 agent，MUST NOT 报错阻断对话。深链只在会话尚未产生回合时尝试
切换；URL 参数在一次消费后 SHALL 从地址栏清除，避免刷新时重复切换。

#### Scenario: 安装引导直通选中

- **WHEN** 用户从功能集安装报告点击「打开对话」落地 `/chat?preset=<agentId>` 且该 agent 已安装
- **THEN** 连接就绪后页面发送 `set_agent`，「与谁对话」控件与头部显示该 agent

#### Scenario: 目标已卸载时诚实降级

- **WHEN** 用户落地 `/chat?preset=<agentId>` 且该 agent 不在 roster 中
- **THEN** 页面显示「该助手已不在」类原因提示，保持当前 agent，对话可用

#### Scenario: 参数一次消费

- **WHEN** 深链切换完成（或明确失败）后用户刷新页面
- **THEN** URL 已不含 `preset` 参数，不发生重复切换

### Requirement: 超长用户回合可折叠

用户回合 SHALL 在正文超过阈值时默认截断展示，并提供一个展开/收起入口。截断 SHALL 保持首行语义（第一行始终可见），收起态 SHALL 明确指示还有内容未展示。

用户回合的折叠状态 SHALL 是查看行为，SHALL NOT 影响会话内容、编辑、重发或镜像记录——折叠后用户仍能取到全文。

#### Scenario: 超长提示词默认截断

- **WHEN** 用户回合的正文长度超过阈值
- **THEN** 该回合 SHALL 默认以折叠态展示
- **AND** SHALL 提供展开入口

#### Scenario: 短回合不出现折叠控件

- **WHEN** 用户回合的正文未超过阈值
- **THEN** 该回合 SHALL 完整展示且不出现折叠控件

#### Scenario: 折叠不影响内容

- **WHEN** 用户回合处于折叠态
- **THEN** 该回合记录的原文 SHALL 保持完整
- **AND** 编辑/重发与模型收到的内容 SHALL 不受折叠影响

### Requirement: 离开转录底部时提供回到底部入口

转录 SHALL 在用户向上滚动离开底部时呈现一个"回到底部"入口，激活后回到转录末尾。入口 SHALL 在用户已处于底部时隐藏。

当有回合正在流式输出且用户停留在上方阅读时，入口 SHALL 保持可达，SHALL NOT 因新内容到达而强制把视图拽回底部。

#### Scenario: 向上滚动后出现入口

- **WHEN** 用户在长转录中向上滚动离开底部
- **THEN** "回到底部"入口 SHALL 出现

#### Scenario: 回到底部后入口消失

- **WHEN** 用户激活入口并到达转录末尾
- **THEN** 该入口 SHALL 隐藏

#### Scenario: 阅读上方时不被打断

- **WHEN** 用户停留在转录上方阅读，而新回合内容正在流式到达
- **THEN** 视图 SHALL NOT 被强制拽回底部
- **AND** "回到底部"入口 SHALL 保持可达

### Requirement: 大纲标注当前所在回合

对话大纲 SHALL 指示当前视口所在的回合，使用户在长会话中既能看到全貌也能定位当前位置。指示 SHALL 随滚动更新，并且 SHALL 在用户点击某条目跳转后立即反映该条目。

#### Scenario: 滚动时当前位置更新

- **WHEN** 用户滚动长转录
- **THEN** 大纲 SHALL 标出当前视口所在的回合

#### Scenario: 跳转后立即定位

- **WHEN** 用户点击大纲中的一个条目
- **THEN** 视图 SHALL 滚动到该回合
- **AND** 大纲 SHALL 立即把该条目标为当前位置

#### Scenario: 短会话不出现大纲

- **WHEN** 会话的用户回合数未达到大纲阈值
- **THEN** 大纲 SHALL NOT 渲染（阈值行为不变）

### Requirement: 壹座页面挂载萬星跨线副驾并递送本站特有上下文

壹座 web SHALL 以 `copilot.js` loader 单标签挂载萬星跨线副驾（`data-line="yizuo"`），
SHALL NOT 自行实现 postMessage 协议。

挂载 SHALL 按路由收窄：**本身已有原生对话入口**的页面 MUST NOT 呈现萬星副驾——整页对话
（`/chat*`）、房间对话（`/zhiyu*`）、线看板与舰队页与市场页（这三类面由页面内的
`CopilotDock` 承担带线上下文的对话）、以及登录中转页。其余页面（配置、知识库、记忆、
应用中心、团队、设备等）SHALL 维持挂载。

「不呈现」MUST 同时意味着不占据交互区域：被收起的跨线副驾 MUST NOT 拦截宿主页面点击。

同一页面在任一时刻 SHALL 至多呈现一个对话入口。

宿主 SHALL 提供 `context()` 钩子，返回本站特有的页面上下文，至少包含当前路径；
在看板页 SHALL 额外带 board line，在 pack 检查页 SHALL 额外带该 pack 的标识。
上下文形状 SHALL 为 `{ line?, page?, entity?, intent? }`，与萬星宿主协议一致。

壹座的宿主身份模型是 `forward_auth`（身份由代理头注入，浏览器侧无 ID token），
与萬星 `identify()` 契约要求的 ID token 不兼容。壹座 SHALL NOT 实现 `identify()`；
副驾的身份升级 SHALL 由萬星自身的登录流程承担——访客首次使用时经萬星 popup 登录一次，
此后该浏览器内免登录，额度为完整访客额度而非匿名日额。

这是明确的体验折中（壹座用户需单独登录一次萬星），SHALL NOT 被当作缺陷修复，
除非将来改为「宿主服务端身份断言」形态。

#### Scenario: 副驾在壹座页面上浮起

- **WHEN** 用户打开一个没有原生对话入口的壹座页面
- **THEN** 萬星副驾按绑定解析结果挂载，未绑定或已暂停时不注入（页面不留死卡）

#### Scenario: 主对话页不出现第二个对话入口

- **WHEN** 用户打开 `/chat` 或某个 `/zhiyu` 房间
- **THEN** 页面上不存在萬星副驾的圆钮，也不存在任何第二个对话输入框

#### Scenario: 看板页只有 dock 一个对话入口

- **WHEN** 用户打开 `/boards/facet`
- **THEN** 页面头部有副驾 dock 入口，且不存在萬星副驾的圆钮

#### Scenario: 首次使用经万星登录升级

- **WHEN** 已登录壹座的用户首次打开副驾并发起回合
- **THEN** 副驾提示登录萬星；用户完成万星 popup 登录后即以完整访客额度对话，
  此后同一浏览器内免再登录

#### Scenario: 看板页带 board line

- **WHEN** 用户在 `/boards/facet` 打开副驾并提问
- **THEN** 首轮消息带标记前缀，其中含该看板的 line 标识，agent 能据此理解用户在看的哪条线

#### Scenario: 未登录时按绑定层级工作

- **WHEN** 未登录访客在壹座打开副驾
- **THEN** 副驾按万星侧该线绑定的访客层级工作（该线当前配置为需登录），不报错也不留死卡

### Requirement: 跨线副驾与 CopilotDock 的职责边界

壹座的 `CopilotDock` SHALL 保留，职责收窄为**运行时操作**：切换该 cell 使用哪个 pack
作为助手（`preset`，会重启运行时）、以及 pack 的深度检查交互。

「这条产品线的对外副驾」这个角色 SHALL 归萬星跨线副驾承担，四条线统一身份、额度与协议。

`CopilotDock` 的 preset 注入与关闭后恢复行为 SHALL 保持不变。

两者 SHALL NOT 同屏并存：有 `CopilotDock` 入口的面上萬星副驾 MUST NOT 呈现；其余
页面只有萬星副驾。用户因此不需要在视觉或文案上分辨「哪个是对话、哪个是设置」——
所在面即判据。

#### Scenario: dock 的 preset 切换照旧可用

- **WHEN** 用户从看板打开 CopilotDock 并切换聚焦预设
- **THEN** 运行时切换生效，主对话 agent 选择器同步反映，关闭时按既有规则恢复

#### Scenario: 跨线副驾不承担 preset 切换

- **WHEN** 用户在萬星副驾里要求「换一个助手」
- **THEN** 副驾不执行 preset 切换（那是运行时操作，跨站协议不支持），只作说明或引导到 dock

#### Scenario: 两个入口不同屏

- **WHEN** 用户在有 `CopilotDock` 入口的面上
- **THEN** 該面上不存在萬星副驾入口；导航到配置类页面时反之，萬星副驾出现而 dock 入口不存在

#### Scenario: 两个入口并存不混淆

- **WHEN** 壹座页面同时存在萬星副驾浮窗与 CopilotDock 入口
- **THEN** 两者的入口在视觉或文案上可区分——一个用于对话、一个用于切换助手与检查 pack

### Requirement: 萬星跨线副驾以收起态挂载

壹座挂载萬星跨线副驾时 SHALL 让其初始为收起态（仅呈现启动器），
MUST NOT 在页面加载后自动展开面板；展开 SHALL 由用户点击启动器触发。

首屏 SHALL NOT 同时出现两个可展开的助手浮层——萬星副驾保持收起，副驾 dock 只在有线
上下文的面上以页面内控件存在。

#### Scenario: 首屏只见到启动器

- **WHEN** 用户打开查看板的壹座页面
- **THEN** 右下角只有萬星副驾的启动器（收起态），没有自动展开的助手面板

#### Scenario: 用户点击后展开

- **WHEN** 用户点击萬星副驾的启动器
- **THEN** 副驾面板展开，此后按其协议工作（上下文、身份升级、问询卡不变）

### Requirement: 清除与失效的上下文不得被当作仍然有效

当副驾上下文被清除、或因宿主页面变化而失效时，上下文条 SHALL 不再显示该上下文，
且副驾 MUST NOT 在后续回合中继续以它为据作答。若模型侧仍收到该上下文（例如清除失败），
界面 SHALL 如实反映「仍在递交」，MUST NOT 显示为已清除。

#### Scenario: 清除失败不谎报成功

- **WHEN** 用户清除上下文但模型侧仍将收到该上下文
- **THEN** 界面不显示为已清除，并说明当前仍递交的状态

### Requirement: 副驾能力对其所属面可见

副驾 SHALL 能让用户问出并得到真实回答：这一面用的是哪个助手、能读什么、能不能改东西。
回答 SHALL 来自当前生效的副驾配置与工具面，MUST NOT 是写死的宣传文案。

#### Scenario: 用户问副驾能做什么

- **WHEN** 用户问「你在这个页面上能干什么」
- **THEN** 副驾如实报出本面可读的数据与可提议的动作范围
