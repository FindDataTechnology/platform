## ADDED Requirements

### Requirement: 注入的 MCP 行名必须通过运行时校验

注入到运行时的连接器 MCP 行，其 `serverName` SHALL 满足 dsh mcp-client 插件的
`^[A-Za-z0-9_-]{1,32}$` 约束。名字 SHALL 由「前缀 + slot 的 slug + 短哈希」构成，
使不同 slot SHALL NOT 撞名，同一 slot SHALL 得到稳定名字。

从名字回解 slot SHALL NOT 依赖字符串解析，SHALL 用产生该名字的同一份定义反查；解析不到时
SHALL 视为非绑定行，SHALL NOT 猜测。

#### Scenario: 名字合规且可反查

- **WHEN** 为任一绑定 slot 生成注入行
- **THEN** 其 `serverName` 匹配 `^[A-Za-z0-9_-]{1,32}$`
- **AND** 用同一份定义可把该名字反查回原 slot

#### Scenario: 不合规的外来名字被收紧

- **WHEN** 运行时收到一个含冒号、空格或超长的 `serverName`
- **THEN** 它在写入运行时配置前被收紧为合规名字
- **AND** 两个不同的原始名字不会收紧成同一个名字
