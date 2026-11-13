## REMOVED Requirements

### Requirement: Stop and session-switch cancel the turn via the bridge
**Reason**: 切会话不再取消任何回合——离开的会话其回合在后台继续（concurrent-chat-sessions）。唯一的取消来源是用户显式停止，由下面的替代需求单独陈述。
**Migration**: 依赖「切走即中止」的客户端必须对目标会话显式发 `stop_turn`。原场景「switching sessions no longer restarts the runtime」由 chat-history「switching away from a streaming session leaves it running」取代。

## ADDED Requirements

### Requirement: Only an explicit stop cancels a turn; session navigation never does

用户显式停止 SHALL 经 `session/cancel` RPC 真中断目标会话的活跃回合（见 live-runtime-control），SHALL NOT 以重启子进程方式停流。取消后的回合 SHALL 以中止态收尾：`error`（如适用）→ `done` 播报照常，目标会话的流状态复位。切会话、新建会话、深链打开、另一连接的导航 SHALL NOT 触发任何会话的取消；离开的会话其回合 SHALL 继续运行，事件照常进入该会话的重放缓冲并投给仍在观看它的连接。显式停止 SHALL 同样覆盖 remote-agent fork 的回合（中止其请求并以中止态收尾）。客户端的视图级停止（`stopStreaming`）保留为降级路径（桥未声明能力时）。

#### Scenario: stop cancels server-side
- **WHEN** 用户在流中点击停止且桥声明 `session/cancel`
- **THEN** 服务端 SHALL 中断该会话回合并广播 `done`
- **AND** 该回合 SHALL 标记为中断（非静默吞事件）

#### Scenario: switching away leaves the turn running
- **WHEN** 会话 A 流中用户切到会话 B
- **THEN** 服务端 SHALL NOT 对 A 发 `session/cancel`，A 的回合 SHALL 继续直至自然收尾
- **AND** A 的后续事件 SHALL 只投给仍在观看 A 的连接并进入 A 的重放缓冲
- **AND** 用户切回 A 时 SHALL 经 `session_loaded{running:true, turnEvents}` 看到进行中的回合并继续收流

#### Scenario: stop on a remote-agent turn closes it
- **WHEN** 某会话正在以 remote-agent fork 流式回复，用户点击停止
- **THEN** 服务端 SHALL 中止该请求并对该会话广播中止态收尾与 `done`

### Requirement: Queued prompt renders as a pending bubble with cancel and preempt actions

当前视图会话收到 `queued`（或 `session_loaded.queued`）时，客户端 SHALL 在转录末尾渲染一个排队气泡：显示提交的文本、「排队中」状态、以及被等待的会话标题（`waitingOn` 为 null 时显示「等待运行时空闲」）。气泡 SHALL 提供「取消」（发 `stop_turn{id: 当前会话}`）；`waitingOn` 非 null 时还 SHALL 提供「停止它并立即执行」（发 `stop_turn{id: waitingOn.id}`）。排队态下当前会话的 `canSend` SHALL 为 false。收到 `dequeued{reason:"dispatched"}` 时气泡 SHALL 让位给随后的正常 `user` 回显；收到 `dequeued{reason:"cancelled"}` 时气泡 SHALL 移除且文本 SHALL 回填到输入框。该气泡 SHALL NOT 被视为历史消息（刷新后由 `session_loaded.queued` 还原，而非转录）。

#### Scenario: queued bubble appears and resolves on dispatch
- **WHEN** 用户在 B 提交且服务端回 `queued`
- **THEN** B 的转录末尾 SHALL 出现带文本与「等待《A 的标题》完成」的排队气泡，发送 SHALL 被禁用
- **AND** 收到 `dequeued{dispatched}` 后气泡 SHALL 被正常用户气泡与 `agent_start` 流程取代

#### Scenario: cancel returns the text to the composer
- **WHEN** 用户点击排队气泡的「取消」且服务端回 `dequeued{cancelled}`
- **THEN** 气泡 SHALL 移除，输入框 SHALL 回填该文本，`canSend` SHALL 恢复

#### Scenario: preempt stops the running session
- **WHEN** 用户点击「停止它并立即执行」
- **THEN** 客户端 SHALL 发 `stop_turn{id: waitingOn.id}`
- **AND** 随后 B SHALL 收到 `dequeued{dispatched}` 并开始正常回合
