## MODIFIED Requirements

### Requirement: persona 必须结构化且槽位语义逐字保留

每个岗位的 persona 必须（SHALL）含职责边界（什么不归我管）与输出契约（report_status 必含项），且必须（SHALL）逐字保留改版前的工作节拍、报数槽位与「未取得如实报、绝不编造」纪律——深化是加厚，不是改写语义。业务团队批（batch 2）中改版前未声明槽位的岗位（柏讯本体建设五岗），必须（SHALL）在改版稿里新增 report_status 契约并显式声明槽位，不得留空。

#### Scenario: 槽位漂移被拒
- **WHEN** 改版稿改变了 persona 声明的 report_status 槽位集合
- **THEN** 发布前的内容基线断言失败，不允许上架

#### Scenario: 槽位名单自动派生，不手抄
- **WHEN** 业务团队批校验某岗位的新 persona
- **THEN** 槽位名单从 staging/source-snapshot.json 的改版前 persona 正则派生（「槽位：a/b」），逐项断言在新 persona 中出现，不依赖手维护的槽位表

#### Scenario: 无契约岗位补齐
- **WHEN** 改版前 persona 完全没有 report_status 契约（本体建设五岗）
- **THEN** 新 persona 必须含 report_status 与显式槽位，基线测试与发布脚本同源拦截

### Requirement: skills 桶可执行，mcp 桶如实

每支 starter 团队必须（SHALL）有至少两条真实可执行的技能（程序性规范，零编造工具名）；mcpServers 只允许（SHALL）钉真实在册且同域的 registryName，allowTools 必须（SHALL）是 registry 里真实存在的工具叶名且非空；工具由运行时注入的团队如实留空。业务团队批的口径同此：技能名必须（SHALL）落在发布门字符集 `[A-Za-z0-9._-]{1,64}`，技能内容 ≥200 字，同包升级按 name upsert（重名跳过会让新版发不出去）。

#### Scenario: 空桶门面被拒
- **WHEN** 一支 starter 团队的 skills 不足两条
- **THEN** 内容基线断言失败，不允许上架

#### Scenario: persona 引用的工具面必须在册
- **WHEN** 某岗位 persona 声明使用某个 MCP 面（如闸位用 fd-sentiment 打分），而该 registryName 未钉进该包 mcpServers
- **THEN** 改版必须补齐该 registryName 与真实工具叶名（情报舆情团队批：fd-sentiment 五个工具叶），否则工具面对岗位不可达

#### Scenario: 工具名不在册被拒
- **WHEN** allowTools 里出现 registry-allowtools.json 未记录的工具名
- **THEN** 发布脚本 dry-run 报错，不上架

### Requirement: 结构与身份不变

编队结构、cadence、kpiSlots、guide、包名、分类与标签必须（SHALL）与改版前逐字一致；agent 的 id/name/description 等非 persona 字段也必须（SHALL）逐字一致；发布走既有原作者发布门（同 id v+1），不改行作者。业务团队批的叠加约束：overlay 只允许（SHALL）出现 personas/skills/mcpServers 三个内容桶；既有 mcpServer 条目一条都不许删改，只许新增。

#### Scenario: 结构漂移被拒
- **WHEN** 改版合并后的 manifest 与改版前在编队/节拍/guide 上有 diff
- **THEN** 发布脚本在 dry-run 报错拒绝

#### Scenario: 身份漂移被拒
- **WHEN** 发布会话不是该包原作者（aloadtree@gmail.com）
- **THEN** 发布脚本在身份闸退出，且发布门自身拒绝非作者再发布

## ADDED Requirements

### Requirement: 批量改版必须留可复核溯源

业务团队批必须（SHALL）把改版前的全量内容快照（source-snapshot.json：每支包每岗位的 persona 原文、技能名、mcp registryName）与 registry 工具真值（registry-allowtools.json）随改版稿一起入库，作为槽位派生、工具名核验与后续回滚的溯源。

#### Scenario: 无溯源不发布
- **WHEN** staging 缺 source-snapshot.json 或 teams/ 里的包不在快照内
- **THEN** 发布脚本与基线测试都拒绝运行

#### Scenario: 覆盖不齐即拒
- **WHEN** teams/ 的支数与快照的包数不一致，或某包的岗位集合与快照不一致
- **THEN** 基线测试失败并点名缺哪支/哪岗
