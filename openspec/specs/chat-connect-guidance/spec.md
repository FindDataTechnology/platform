# chat-connect-guidance Specification

## Purpose

对话内连接引导：模型车道或 MCP 工具因凭据失败时，服务端把失败分类为「去哪里连」的结构化指针旁挂在 WS 事件上，聊天界面在错误块与失败工具块里渲染「去连接」深链到连接中心的对应面板。分类只增字段、不改模型可读文本、不进持久化——引导是「此刻怎么办」，不是历史注解。

## Requirements

### Requirement: 凭据类失败携带连接指引

WHEN a model-lane turn fails with a credential-shaped error（401/403, unauthorized, invalid or incorrect API key, credential failure）, the turn error event delivered to clients SHALL carry a connection pointer to the 词元 account panel（the user-side repair path for model credentials after ciyuan-account-lane）. WHEN an MCP tool call fails with a credential-shaped error and the failing tool's server resolves to a known credential ref, the tool failure event SHALL carry a connection pointer to that ref's connect panel. Errors that are not credential-shaped, and tool servers without a credential ref, SHALL carry no pointer. Classification SHALL be additive: the model-visible transcript text and persisted blocks SHALL NOT be modified by guidance.

范围不足 SHALL 单独成类，与凭据失效区分：WHEN a connector tool call fails because the action or connection is outside the current binding's granted scope（`action_not_allowed` / `connection_not_allowed`）, the tool failure event SHALL carry a **scope pointer**（provider + operation class 读/写）rather than a credential pointer, and SHALL be classified as「范围不足」. A genuine credential failure on the same server SHALL keep the credential classification. 两类指针 SHALL NOT 同时挂在同一事件上。

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

#### Scenario: 范围不足挂权限指针而非凭据指针

- **WHEN** 某条绑定行（`connector:<packId>:<bindingKey>`）上的工具调用返回 `action_not_allowed`
- **THEN** 失败事件携带 scope 指针（provider + 读/写）并归类为「范围不足」，不带凭据失效指针

#### Scenario: 真凭据失效仍走凭据分类

- **WHEN** 同一绑定行的调用返回 401 且该令牌已失效
- **THEN** 事件携带凭据失效指针并归类为凭据问题，不误报为范围不足

#### Scenario: 两类指针互斥

- **WHEN** 某次失败既非纯凭据问题也无明确范围判定
- **THEN** 事件只携带其中一类指针或不携带，MUST NOT 同时挂两类

### Requirement: 聊天把指引渲染为可点的连接动作

The chat UI SHALL render, inside an error block or a failed tool block that carries a connection pointer, an action control labeled 去连接（localized）that deep-links to the connection center with the pointed panel highlighted（`/settings/connections?panel=<panel>`）. Blocks without a pointer SHALL render no such control. Replayed history（which persists no pointer）SHALL render without the control.

#### Scenario: 错误块出现去连接按钮

- **WHEN** an error block carrying `connect` renders
- **THEN** a 去连接 control is present and navigates to `/settings/connections?panel=<panel>` on activation

#### Scenario: 无指引不渲染

- **WHEN** an error block or failed tool block carries no `connect`
- **THEN** no connect control renders in that block
