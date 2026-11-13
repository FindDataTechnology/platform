## Purpose

官方 starter 团队是三桶模型的门面示范：新用户从这里第一次看到「一个 agent 长什么样」。内容必须配得上展示位——persona 结构化、技能桶可执行、工具桶如实（真实在册才钉，运行时注入就留空），而编队结构与节拍保持已验证的形状。

## ADDED Requirements

### Requirement: persona 必须结构化且槽位语义逐字保留

每个岗位的 persona 必须（SHALL）含职责边界（什么不归我管）与输出契约（report_status 必含项），且必须（SHALL）逐字保留 v6 的工作节拍、报数槽位与「未取得如实报、绝不编造」纪律——深化是加厚，不是改写语义。

#### Scenario: 槽位漂移被拒
- **WHEN** 改版稿改变了 persona 声明的 report_status 槽位集合
- **THEN** 发布前的内容基线断言失败，不允许上架

### Requirement: skills 桶可执行，mcp 桶如实

每支 starter 团队必须（SHALL）有至少两条真实可执行的技能（程序性规范，零编造工具名）；mcpServers 只允许（SHALL）钉真实在册且同域的 registryName（allowTools=[]），工具由运行时注入的团队如实留空。

#### Scenario: 空桶门面被拒
- **WHEN** 一支 starter 团队的 skills 不足两条
- **THEN** 内容基线断言失败，不允许上架

### Requirement: 结构与身份不变

编队结构、cadence、kpiSlots、guide 与包名必须（SHALL）与 v6 逐字一致；发布走既有原作者发布门（同 id v+1），不改行作者。

#### Scenario: 结构漂移被拒
- **WHEN** 改版合并后的 manifest 与 v6 在编队/节拍/guide 上有 diff
- **THEN** 发布脚本在 dry-run 报错拒绝
