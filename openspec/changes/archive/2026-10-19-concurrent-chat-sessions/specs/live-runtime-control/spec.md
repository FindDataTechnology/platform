## MODIFIED Requirements

### Requirement: Bridge exposes real turn cancellation via session/cancel

平台桥插件 SHALL 支持自定义 JSON-RPC 方法 `session/cancel`，参数 `{ sessionId: string, cause?: string }`。实现 SHALL 调用 dsh 原生 `agent.cancel(cause)` 中断该会话的活跃回合，并在 `whenIdle()` 收敛后返回。平台侧「用户显式停止」SHALL 经此方法实现，SHALL NOT 以重启子进程的方式停止回合。切会话 SHALL NOT 调用 `session/cancel`——离开的会话其回合继续运行（见 chat-history「Users can switch the active chat session without disturbing in-flight turns」与 turn-dispatch）。取消 SHALL 使该会话的回合以中止态收尾并照常走 `done` 播报。

#### Scenario: 用户停止按钮真中断

- **WHEN** 流中用户点击停止，宿主调用 `session/cancel {sessionId: S}`
- **THEN** 子进程 SHALL 中断 S 的活跃回合
- **AND** 观察端 SHALL 收到该回合的中止收尾与 `done`

#### Scenario: 切会话不再重启

- **WHEN** 会话 A 流中用户切到会话 B
- **THEN** 宿主 SHALL NOT 重启子进程，也 SHALL NOT 对 A 调用 `session/cancel`
- **AND** 切换 SHALL 即时完成，A 的回合继续直至自然收尾

#### Scenario: 取消空闲会话为无害空操作

- **WHEN** `session/cancel` 目标会话无活跃回合
- **THEN** SHALL 返回成功且不产生额外回合事件
