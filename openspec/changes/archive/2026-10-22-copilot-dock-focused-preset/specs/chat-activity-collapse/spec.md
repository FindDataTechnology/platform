## ADDED Requirements

### Requirement: 待确认的动作提议自动展开其活动组

活动组中含有一个仍在等待用户确认或取消的 `propose_action` 调用（调用进行中，或其提议状态为 pending）时，该组 SHALL 自动展开，使动作确认卡在不展开任何折叠头的情况下可见；与「报错活动自动展开」「进行中的提问卡不折叠」同一条「绝不把用户要回答的东西藏在折叠头后面」规则。提议被执行、拒绝或过期后，该组 SHALL 恢复默认折叠行为，历史回放时该卡 SHALL 在展开后以已执行面呈现。`propose_action` 的识别 SHALL 按工具名后缀匹配（运行时的工具名为 `mcp__<server>__propose_action`），MUST NOT 依赖裸名全等。

#### Scenario: 待确认提议不折叠

- **WHEN** 一个助手回合的活动组包含一条 `mcp__actions__propose_action` 调用，其返回的提议状态为 pending
- **THEN** 该组渲染为展开，确认卡及其确认/取消按钮无需任何点击即可见，且该调用不以通用工具块呈现

#### Scenario: 已执行提议随组折叠

- **WHEN** 同一回合的提议状态为 executed
- **THEN** 该组默认折叠，用户展开后看到已执行面，不再出现确认按钮
