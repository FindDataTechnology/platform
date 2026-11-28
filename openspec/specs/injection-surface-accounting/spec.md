# injection-surface-accounting Specification

## Purpose
让「这个角色需要哪些 MCP 工具」这件事实可以被声明、被裁剪、被读出来：显式声明「不需要工具」的角色不再为全部工具付费，而合成出的注入面在日志与回合记录里是可查的数字。

## Requirements

### Requirement: 显式空声明与未声明必须区分
包中的一个角色或一份自建预设 SHALL 能用显式空值声明「本角色不加载任何 MCP server」。系统 SHALL 把显式空与完全未声明解析成两个不同的结果：显式空 MUST 裁剪到「仅保留记忆类服务」，完全未声明 MUST NOT 裁剪（保留全量合成）。

#### Scenario: 包内角色显式声明无工具
- **WHEN** 一个包的角色带 `resources.mcpServers: []` 或 `resources.mcpTools: {}`
- **THEN** 该角色合成出的 profile 只保留记忆类服务，其余 server 不进入其工具面

#### Scenario: 完全未声明仍然不裁剪
- **WHEN** 一个包的角色没有任何 `resources.mcpServers` / `resources.mcpTools` 字段
- **THEN** 该角色保持既有行为（不裁剪），且注入面记账里 SHALL 能看出这是「未声明」而非「声明为空」

### Requirement: 一次合成的注入面必须可查
每次为某个角色合成 MCP patch 时，系统 SHALL 记录本次生效的 server 数、技能根数与技能字节数，并写入（a）进程日志一行，（b）与该角色 patch 同目录的一份 surface 记录。该记录 SHALL 来自合成期的实际取值，MUST NOT 由事后推算。

**为什么不写进回合 detail**：回合写入链路拿不到 profile 路径，要反查一次成员→profile 映射，且每回合都要；而合成日志与 sidecar 已经回答了同一个问题（「这个岗付了多少工具钱」），且能在事后按角色直接读。写进 detail 会为一层冗余付每回合的代价。

#### Scenario: 合成后日志有据
- **WHEN** 为某角色合成 profile
- **THEN** 日志出现一行形如「N MCP server(s), M skill root(s), K skill byte(s)」，且该行在线上可被检索到

#### Scenario: 可按角色事后读回
- **WHEN** 需要查某个角色当前付了多少注入面
- **THEN** 该角色 patch 同目录的 surface 记录给出 server 数、技能根数与技能字节数，数值与同次合成日志一致

### Requirement: 同一服务的多个别名必须去重
合成时若同一个 MCP 服务以多个名字出现（如 `facet-market` 与 `facet-market-mcp` 指向同一端点），系统 SHALL 按服务身份合并为一个条目，并在日志里点名被合并的别名。

#### Scenario: 别名合并
- **WHEN** 某个 profile 里同时出现同一服务的两个名字
- **THEN** 合成结果只保留一份，日志列出被合并的别名

### Requirement: 台账之外的事实不虚构
注入面记账 SHALL 只报实测的 server 数、技能根数与技能字节数，MUST NOT 估算 token 成本或猜测 schema 体积。

#### Scenario: 不估算 token
- **WHEN** 某次合成的注入面被记录
- **THEN** 记录里只有计数与字节，没有估算出的 token 数
