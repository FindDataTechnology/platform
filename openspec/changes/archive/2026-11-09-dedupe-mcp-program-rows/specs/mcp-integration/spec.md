## ADDED Requirements

### Requirement: 同一 program 只对应一行 MCP

MCP 组合 SHALL 以 program（`command` 与其 `args`）标识「同一个服务器」，而不是以其名字。
当部署基线与打包清单以不同名字指向同一 program 时，托管 cell 的组合结果 SHALL 只包含一行；
运行期 SHALL NOT 为同一 program 拉起多于一个子进程。url 型条目无 `command`，
SHALL NOT 参与 program 判重。

#### Scenario: 托管 cell 同时有基线与 bundle 的同程序异名条目
- **WHEN** 某 cell 的 `mcp.json` 声明 `actions`、bundle 声明 `actions-mcp`，两者 `command`/`args` 相同
- **AND** 该 cell 启动
- **THEN** 组合结果只保留基线那一行（`actions`）
- **AND** 日志记一条「bundled "actions-mcp" is the same program as "actions"; skipping the duplicate」

#### Scenario: 老库已存在重复的 bundle 行
- **WHEN** 某 cell 的库里已存在同名程序的一行，且其 `origin` 为 `bundled`
- **THEN** 启动时 SHALL 删除该行并记「removed duplicate bundled …」
- **AND** 下一份 patch 里该名字不再出现

#### Scenario: 运维手工添加的同名行
- **WHEN** 同名程序的行 `origin` 非 `bundled`（运维/用户添加）
- **THEN** 该行 SHALL NOT 被删除，日志只记 skip
- **AND** 平台 MUST NOT 代替运维删除其配置

#### Scenario: 基线那份被禁用
- **WHEN** 基线的行已被管理员禁用，而 bundle 的同程序条目仍在
- **THEN** bundle 条目 SHALL 照常种入（禁用一个名字不得导致该能力完全消失）

#### Scenario: 打包/桌面形态（无 mcp.json）
- **WHEN** 部署没有 `mcp.json`（打包版），bundle 是唯一来源
- **THEN** program 判重 SHALL NOT 触发，bundle 的名字照常种入
