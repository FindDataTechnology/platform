# agent-runner 变更（fix-turn-token-attribution）

## MODIFIED Requirements

### Requirement: Turn events carry session and token attribution

回合生命周期事件（turn_started/turn_ended）SHALL 在 payload 中携带该回合的 `session`（运行时会话名——mission 派发回合即 `srv-mission-<id>`，外部上下文即其 `wx:` 名），使下游观测面能把回合归属到发起源；turn_ended SHALL 在 usage 可得时携带 `tokens`（输入/输出合计或原样 usage 摘要）。`tokens` 的合计 SHALL 兼容两种 usage 命名：OpenAI 风格总数（`total_tokens`/`totalTokens`/`tokens`）优先，dsh harness 风格分列（`inputTokens`/`input_tokens` + `outputTokens`/`output_tokens`，cache 不计入）求和回退；两形状都不匹配时字段缺席而非置空（不猜）。未知字段的既有消费方 SHALL 不受影响（纯增量载荷）；不可得时字段缺席而非置空。

#### Scenario: A mission dispatch turn attributes to its session

- **WHEN** 一个以 `mission:<id>` 上下文派发的回合在 runner 侧开始与结束
- **THEN** 对应 turn_started/turn_ended 事件的 payload.session 以该 mission 的会话名开头，turn_ended 带 tokens

#### Scenario: Existing consumers are untouched

- **WHEN** 升级后的 runner 服务既有 agent（spider-heal 等）
- **THEN** 其回合照常计量与上报，仅 payload 多出可选字段，无行为变化

#### Scenario: dsh harness 分列 usage 求和成 tokens

- **WHEN** 一回合的 assistant/message 事件携带 dsh harness 形状 usage（如 `data.usage = {inputTokens: 120, outputTokens: 30}`）
- **THEN** 该回合计量行与 turn_ended 事件的 tokens = 150（input+output 求和，cache 不计入）；OpenAI 风格总数命名仍按原样取用
