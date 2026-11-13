## MODIFIED Requirements

### Requirement: cell 记忆挂载遵守组合与凭据纪律

壹座 cell 的 dsh 组合 SHALL 注入 fd-memory MCP 行（工具名 `mcp__fd-memory__*`）：人令牌按 owner 由 cell 后端经 platform 令牌代铸并缓存，注入路径与既有 MCP 凭据引用纪律同源（值不落明文配置文件）；挂载开启时，cell 的每个 persona 预设 SHALL 同时携带记忆纪律文案（引导 agent 开场查交接、收尾写交接），文案与舰队部署的纪律文案 MUST 取自同一来源（单一模块，字节相同）；fd-memory 不可达时 cell 会话 MUST 降级开放（无记忆工具或工具报不可用，会话不因此失败）；挂载可经部署配置关闭，关闭时 MCP 行与纪律文案 MUST 一并消失。

#### Scenario: cell 会话见记忆工具并写入落库

- **WHEN** 一个壹座 cell 会话运行并调用 memory_handoff_begin
- **THEN** handoff 落 `u/<owner>/p/cell` namespace，舰队侧可检索

#### Scenario: 挂载开启时 persona 携带纪律文案

- **WHEN** 部署配置开启 cell 记忆挂载并写出 preset 组合
- **THEN** 标准预设与每个目录 / 自定义预设的 persona 都含记忆纪律文案，且该文案与舰队部署 runner 注入的文案是同一字符串

#### Scenario: 关闭开关回零

- **WHEN** 部署配置关闭 cell 记忆挂载
- **THEN** cell 组合输出与现状字节等同（无 MCP 行、无纪律文案、无代铸调用）
