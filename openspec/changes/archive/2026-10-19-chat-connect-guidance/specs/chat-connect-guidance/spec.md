## ADDED Requirements

### Requirement: 凭据类失败携带连接指引

WHEN a model-lane turn fails with a credential-shaped error（401/403, unauthorized, invalid or incorrect API key, credential failure）, the turn error event delivered to clients SHALL carry a connection pointer to the 词元 account panel（the user-side repair path for model credentials after ciyuan-account-lane）. WHEN an MCP tool call fails with a credential-shaped error and the failing tool's server resolves to a known credential ref, the tool failure event SHALL carry a connection pointer to that ref's connect panel. Errors that are not credential-shaped, and tool servers without a credential ref, SHALL carry no pointer. Classification SHALL be additive: the model-visible transcript text and persisted blocks SHALL NOT be modified by guidance.

#### Scenario: 模型车道 401 指到词元卡

- **WHEN** the model request fails with "401 Unauthorized" or "Invalid API key" and the error event reaches the client
- **THEN** the event carries `connect: {panel: "ciyuan-account"}`

#### Scenario: MCP 工具 401 指到所属连接

- **WHEN** a tool call to `mcp__<server>__<tool>` fails with an unauthorized-shaped result and `<server>`'s config resolves to credential ref `registry`
- **THEN** the tool failure event carries a connect pointer to the registry panel

#### Scenario: 非凭据错误与无名服务不附指引

- **WHEN** the turn fails with a network timeout, or the failing tool's server has no credential ref
- **THEN** the events carry no connection pointer

#### Scenario: transcript 文本不被改写

- **WHEN** guidance attaches to a failed tool result
- **THEN** the result text the model reads and the persisted block are byte-identical to the un-guided form

### Requirement: 聊天把指引渲染为可点的连接动作

The chat UI SHALL render, inside an error block or a failed tool block that carries a connection pointer, an action control labeled 去连接（localized）that deep-links to the connection center with the pointed panel highlighted（`/settings/connections?panel=<panel>`）. Blocks without a pointer SHALL render no such control. Replayed history（which persists no pointer）SHALL render without the control.

#### Scenario: 错误块出现去连接按钮

- **WHEN** an error block carrying `connect` renders
- **THEN** a 去连接 control is present and navigates to `/settings/connections?panel=<panel>` on activation

#### Scenario: 无指引不渲染

- **WHEN** an error block or failed tool block carries no `connect`
- **THEN** no connect control renders in that block
