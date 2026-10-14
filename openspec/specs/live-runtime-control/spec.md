# live-runtime-control Specification

## Purpose

dsh 子进程活控制面：平台桥自定义 RPC（model/set 免重启切模型、session/cancel 真取消、tools/set 会话级工具闸）与能力握手降级。宿主经 capabilities 探测启用，旧子进程回落既有路径。

## Requirements
### Requirement: Bridge exposes live model switching via model/set

平台桥插件（platform-preset-bridge，dsh 子进程内）SHALL 支持自定义 JSON-RPC 方法 `model/set`，参数 `{ sessionId?: string, provider: string, model: string, reasoningEffort?: string|null }`。实现 SHALL 经 `installModelSelection`（或等价的 `agent/request` waterfall）为目标会话的 agent 安装可变模型选择；未指定 sessionId 时 SHALL 作用于后续新建的会话。切换 SHALL 不重启子进程，SHALL 由 dsh 原生 step 边界快照保证当前进行中的模型请求不被撕裂——流中切换在后续 step 生效。方法 SHALL 返回 `{ ok: true }` 或结构化错误。

#### Scenario: 空闲会话活切

- **WHEN** 宿主对空闲会话 S 调用 `model/set {sessionId: S, provider: P, model: M}`
- **THEN** 子进程 SHALL 在不重启的前提下把 S 的 agent 选择置为 P/M
- **AND** S 的下一次模型请求 SHALL 路由到 P/M

#### Scenario: 流中切换不撕裂当前请求

- **WHEN** 会话 S 的一个 step 的模型请求已发出，宿主调用 `model/set` 指向新模型
- **THEN** 当前请求 SHALL 按原模型完成
- **AND** 后续 step SHALL 使用新模型

#### Scenario: 未知 provider 或 model

- **WHEN** `model/set` 携带未注册的 provider 或未知 model
- **THEN** SHALL 返回结构化错误且现有选择不变

### Requirement: Bridge exposes real turn cancellation via session/cancel

平台桥插件 SHALL 支持自定义 JSON-RPC 方法 `session/cancel`，参数 `{ sessionId: string, cause?: string }`。实现 SHALL 调用 dsh 原生 `agent.cancel(cause)` 中断该会话的活跃回合，并在 `whenIdle()` 收敛后返回。平台侧「用户停止」与「切会话停流」SHALL 统一经此方法实现，SHALL NOT 再以重启子进程的方式停止回合。取消 SHALL 使该会话的回合以中止态收尾并照常走 `done` 播报。

#### Scenario: 用户停止按钮真中断

- **WHEN** 流中用户点击停止，宿主调用 `session/cancel {sessionId: S}`
- **THEN** 子进程 SHALL 中断 S 的活跃回合
- **AND** 观察端 SHALL 收到该回合的中止收尾与 `done`

#### Scenario: 切会话不再重启

- **WHEN** 会话 A 流中用户切到会话 B
- **THEN** 宿主 SHALL 对 A 调用 `session/cancel` 而 SHALL NOT 重启子进程
- **AND** 切换 SHALL 即时完成（不等子进程重启）

#### Scenario: 取消空闲会话为无害空操作

- **WHEN** `session/cancel` 目标会话无活跃回合
- **THEN** SHALL 返回成功且不产生额外回合事件

### Requirement: Bridge exposes per-session tool gating via tools/set

平台桥插件 SHALL 支持自定义 JSON-RPC 方法 `tools/set`，参数 `{ sessionId: string, server: string, enabled: boolean }`。实现 SHALL 经既有 MCP 工具 guard 层为该会话翻转指定 MCP 服务器的工具闸，SHALL 不重启子进程、SHALL 不影响其他会话的闸状态。未翻转前，会话的闸默认值 SHALL 为平台配置的默认（websearch 默认关）。

#### Scenario: 会话级联网开关即时生效

- **WHEN** 宿主调用 `tools/set {sessionId: S, server: "websearch", enabled: true}`
- **THEN** 会话 S 的后续工具调用 SHALL 放行 websearch 工具，无需重启

#### Scenario: 闸状态会话隔离

- **WHEN** 会话 S 开启 websearch，会话 T 未开启
- **THEN** T 的 websearch 工具调用 SHALL 被拦截，S 不受影响

### Requirement: Capability handshake and degradation

桥插件 SHALL 在握手/名册应答中向宿主声明其支持的自定义方法集（`capabilities` 列表）。宿主在发起 `model/set`/`session/cancel`/`tools/set` 前 SHALL 检查声明；方法缺失时 SHALL 降级为既有行为（模型切换回落 restart 路径并保留流中禁切；停止回落视图级假停；工具开关提示需重启或不可用），SHALL NOT 抛未处理错误。

#### Scenario: 新宿主配旧子进程

- **WHEN** 子进程能力声明不含 `model/set`，宿主收到 `set_model`
- **THEN** 宿主 SHALL 走既有 restart 切换路径
- **AND** 行为与升级前一致，无未处理错误

#### Scenario: 能力声明随名册到达

- **WHEN** 子进程完成 initialize 握手
- **THEN** 宿主 SHALL 能读到其 capabilities 声明并据此启用活控制路径
