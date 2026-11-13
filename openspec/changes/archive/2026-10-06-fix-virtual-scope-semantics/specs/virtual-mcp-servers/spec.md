# virtual-mcp-servers Specification

## Purpose

registry 虚拟 MCP 服务器（聚合多后端工具、对外单一入口）的访问控制与聚合路由行为契约：入口 scope 门与授权模型的 either-or 语义保持一致，工具级 scope 保持合取，拒绝可观测。

## ADDED Requirements

### Requirement: Server-level scope gate is any-of

虚拟 MCP 服务器的 server 级 `required_scopes` SHALL 采用 any-of 语义：调用者持有的 scope 中**任一**出现在列表中即通过入口门；列表为空或缺失时 SHALL 无条件通过。该语义 SHALL 与 scope 授权文档中多 scope 可独立授予同一虚拟服务器访问权的模型一致。入口门 SHALL 作用于全部聚合方法（tools/list、tools/call、resources/list、resources/read、prompts/list、prompts/get）。被入口门拒绝的请求 SHALL 返回 HTTP 200 + JSON-RPC error（MCP 协议层错误），且 SHALL 在网关日志中留下包含服务器标识与所需 scope 列表的警告级记录。

#### Scenario: 单 scope 客户过门

- **WHEN** 虚拟服务器 `required_scopes=[A, B]`，调用者仅持有 scope A，且已通过边缘鉴权（其 scope 授权文档授予该虚拟服务器访问权）
- **THEN** 入口门放行，tools/list 返回聚合工具列表、tools/call 正常代理到后端（不再返回 "Access denied: missing required server scopes"）

#### Scenario: 无任何所需 scope 被拒且留痕

- **WHEN** 虚拟服务器 `required_scopes=[A, B]`，调用者既无 A 也无 B（但持其他 scope 已过边缘鉴权）
- **THEN** 入口门拒绝，返回 JSON-RPC error，网关日志出现含服务器标识与 [A, B] 的警告记录

#### Scenario: 空 required_scopes 放行

- **WHEN** 虚拟服务器 `required_scopes` 为空列表或缺失，调用者已通过边缘鉴权
- **THEN** 入口门放行（入口控制完全由边缘鉴权的 scope 授权文档承担）

#### Scenario: 边缘鉴权语义不变

- **WHEN** 调用者不持有任何授予该虚拟服务器访问权的 scope
- **THEN** 请求在边缘鉴权层被拒（HTTP 403），不进入聚合层——入口门 any-of 是纵深防御的第二层，不替代边缘鉴权

### Requirement: Per-tool scope gate is all-of

per-tool 的 `required_scopes`（工具级 scope 覆盖）SHALL 保持 all-of 合取语义：调用者必须**全部**持有该工具要求的 scope 才能见到（tools/list 列出）与调用（tools/call 代理）该工具。工具未配置 scope 覆盖时 SHALL 不施加额外工具级限制（仅受 server 级入口门约束）。

#### Scenario: 工具要求双 scope 只持其一

- **WHEN** 某工具的 scope 覆盖为 [A, B]，调用者过入口门（持有 A）但缺 B
- **THEN** tools/list 的返回中不出现该工具，tools/call 该工具被拒并返回 JSON-RPC error

#### Scenario: 工具无 scope 覆盖

- **WHEN** 某工具无 scope 覆盖，调用者已过 server 级入口门
- **THEN** 该工具在 tools/list 中列出且 tools/call 正常代理
