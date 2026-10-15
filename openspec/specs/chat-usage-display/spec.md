# chat-usage-display Specification

## Purpose

对话面的 token 用量与上下文水位显示：回合完成携带用量（done 载荷）、回合脚注、输入框旁的上下文水位条。数据源=dsh TokenUsage（挂 assistant/message）。

## Requirements
### Requirement: Turn completion carries token usage

服务端 SHALL 在 `done` 事件载荷中附加该回合的 token 用量 `{ usage?: { inputTokens: number, outputTokens: number } }`（取该回合最后一步 `assistant/message` 事件 `data.usage` 报告的用量——dsh 的 TokenUsage 挂在会话消息事件上，finish chunk 上没有；无数据时省略字段）。载荷为 additive——旧客户端 SHALL 忽略未知字段。

#### Scenario: 正常回合带用量

- **WHEN** 一个回合正常完成且 runtime 报告了 finish 用量
- **THEN** 客户端 SHALL 收到带 `usage` 的 `done` 事件

#### Scenario: 无用量回合省略字段

- **WHEN** 回合完成但 runtime 未报告用量
- **THEN** `done` 载荷 SHALL 不含 `usage` 字段，客户端渲染 SHALL 不报错

### Requirement: Assistant turn footer shows per-turn tokens

助手回合 SHALL 在回合尾部渲染该回合的 token 用量（输入/输出，紧凑格式如 `in 1.2k · out 340`）。无用量数据的回合（历史加载且未持久化用量、或 runtime 未报告）SHALL 省略脚注而非渲染 0。

#### Scenario: 完成回合显示脚注

- **WHEN** 一个带 usage 的回合完成
- **THEN** 该回合尾部 SHALL 显示输入与输出 token 数

#### Scenario: 历史回合无数据省略

- **WHEN** 加载的历史回合没有持久化用量
- **THEN** 该回合 SHALL 不渲染用量脚注

### Requirement: Context meter shows cumulative usage against the model window

对话面 SHALL 显示当前会话的累计上下文用量对当前模型 `contextWindow` 的水位（输入累计为主口径；实现可选含输出）。模型名册未带 `contextWindow` 或累计为 0 时 SHALL 不渲染水位。模型切换后 SHALL 按新模型的窗口重算。

#### Scenario: 水位随回合增长

- **WHEN** 会话完成带用量的回合
- **THEN** 水位 SHALL 反映累计输入 token 相对当前模型 contextWindow 的比例

#### Scenario: 换模型重算

- **WHEN** 用户活切到另一 contextWindow 的模型
- **THEN** 水位 SHALL 立即按新窗口重算显示
