## ADDED Requirements

### Requirement: 驻留回合的岗位持有自身 persona 的工具面

驻留（parked）回合的岗位 SHALL 以**该回合自身的目标 preset** 组合其工具面：其可用的
MCP server 与工具 allowlist SHALL 来自该 preset 自身的声明，SHALL NOT 来自运行时部署默认
preset 的组合。运行时部署默认 preset 不被定时车道移动这一纪律 SHALL 保持成立。

实现上 SHALL 以「按 preset 分段」的方式供给（每个已装 persona 一节精确面 + 一份并集上界），
SHALL NOT 通过「为每回合重写部署级 patch」实现——后者需要子进程重载，等于退回重启。

#### Scenario: 驻留岗位拿到自己的工具

- **WHEN** 一个 persona 岗位以驻留方式执行回合，其 pack 声明了若干 MCP server 与工具 allowlist
- **THEN** 该回合会话内可按工具检索命中该 pack 声明的工具，SHALL NOT 缺位

#### Scenario: 驻留岗位不被默认 persona 的面顶替

- **WHEN** 某 cell 的运行时部署默认 persona 声明了另一组 server 与工具
- **THEN** 驻留回合的工具面按该岗位自己的声明组合，不被默认 persona 的 allowlist 顶替

#### Scenario: 未声明 allowlist 的岗位按既有语义回落

- **WHEN** 某 persona 未声明自己的工具清单，但其所属 pack 在 pack 级声明了 allowTools
- **THEN** 该岗位的面按既有派生语义回落到 pack 级声明，SHALL NOT 凭空收窄或放大

#### Scenario: 默认 persona 不动仍成立

- **WHEN** 驻留回合执行前后
- **THEN** 运行时部署默认 preset 与其组合面保持回合前的值，用户对话车道不受影响
