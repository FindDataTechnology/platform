# pack-tool-declaration-coherence Specification

## Purpose
约束「包声明的工具面」与「它交付的技能文本」之间的一致性：技能点名的工具必须能被该包授予，
且必须在服务真实存在的工具面内。它管的是声明与文本的对账，不是工具本身的行为。

## Requirements

### Requirement: 技能点名的工具必须在包的授予面内

包的每一个技能文本中被点名的工具 SHALL 属于该包对同一 server 的授予面（该 server 的
`allowTools` ∪ 任一角色 `resources.mcpTools` 中列出的 leaf）。技能引用一个包根本未携带的
server SHALL 同样视为不一致。发布 SHALL 在上述任一情形失败并点名 `skill` / `server` / `tool`，
MUST NOT 以警告代替。

「点名」的判据 SHALL 覆盖两种写法：显式 `mcp__<server>__<leaf>`，以及紧随其后的
`/ <leaf>` 串联（技能文本的既有简写 `mcp__srv__a / b / c` 中，`b` 与 `c` 属于同一 server）。
出现在代码围栏内的命中 SHALL 只记为警告，不判失败。

#### Scenario: 缺声明的工具让发布失败

- **WHEN** 一个包声明某 server 的 `allowTools` 为 16 项，而它的技能文本点名了其中没有的 `stop_strategy`
- **THEN** 发布被拒绝
- **AND** 错误点名该技能、该 server 与该工具名

#### Scenario: 补齐后发布通过

- **WHEN** 同一包把被点名的工具补进 `allowTools`
- **THEN** 发布通过
- **AND** 自测对「补前/补后」两份样本分别给出失败与通过，证明判据会响

#### Scenario: 引用未携带的服务也失败

- **WHEN** 包的一个技能文本引用了 `mcp__some-other-server__tool`，而该包的 `mcpServers` 不含该 registry 名
- **THEN** 发布被拒绝并点名该 server

#### Scenario: 代码块里的同形字符串只警告

- **WHEN** 技能文本在一个围栏代码块里出现了 `mcp__srv__leaf` 形态的字符串
- **THEN** 发布不被拒绝
- **AND** 输出一条警告，说明该处未被计入授面对账
