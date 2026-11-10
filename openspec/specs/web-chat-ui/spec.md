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

### Requirement: 全局副驾入口与独立会话

壹座 web SHALL 在所有登录后的页面提供全局副驾入口（悬浮按钮）；打开后 SHALL 在右侧呈现副驾 dock。副驾 SHALL 使用独立会话，MUST NOT 写入或干扰用户当前的主对话会话，MUST NOT 改变主对话的滚动位置与草稿。副驾会话 SHALL 可按线持久化，并在再次打开时恢复。

#### Scenario: 打开副驾不打断主对话

- **WHEN** 用户在主对话流式回答期间打开副驾
- **THEN** 主对话继续流式渲染，副驾在其独立会话中交互

#### Scenario: 关闭再打开恢复上下文

- **WHEN** 用户关闭副驾后再次打开同一看板的副驾
- **THEN** 副驾恢复该线此前的会话内容

### Requirement: 副驾携带看板上下文

从线看板打开副驾时，后续回合 SHALL 携带看板标识、当前筛选与选中对象作为上下文。上下文 SHALL 对用户可见（顶部上下文条），且用户 SHALL 能清除。副驾 MUST NOT 在无上下文时声称知道用户当前在看什么。

#### Scenario: 上下文条可见

- **WHEN** 用户从谦面看板打开副驾
- **THEN** 副驾顶部显示正在看的看板与筛选，并可清除

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
