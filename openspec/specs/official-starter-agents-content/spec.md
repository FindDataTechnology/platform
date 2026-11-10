## Purpose

官方 starter 团队是三桶模型的门面示范：新用户从这里第一次看到「一个 agent 长什么样」。内容必须配得上展示位——persona 结构化、技能桶可执行、工具桶如实（真实在册才钉，运行时注入就留空），而编队结构与节拍保持已验证的形状。

## Requirements

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

### Requirement: 批量改版必须留可复核溯源

业务团队批必须（SHALL）把改版前的全量内容快照（source-snapshot.json：每支包每岗位的 persona 原文、技能名、mcp registryName）与 registry 工具真值（registry-allowtools.json）随改版稿一起入库，作为槽位派生、工具名核验与后续回滚的溯源。

#### Scenario: 无溯源不发布
- **WHEN** staging 缺 source-snapshot.json 或 teams/ 里的包不在快照内
- **THEN** 发布脚本与基线测试都拒绝运行

#### Scenario: 覆盖不齐即拒
- **WHEN** teams/ 的支数与快照的包数不一致，或某包的岗位集合与快照不一致
- **THEN** 基线测试失败并点名缺哪支/哪岗

### Requirement: 助手型与套件型官方包的内容基线

官方货架上的助手型（单岗对话）与套件型（技能束）包，其 persona 深化必须（SHALL）把改版前文本逐字保留为前缀（零改写），并含【职责边界】与【输出契约】结构段且 ≥380 字；输出契约按形态取用——舰队岗为 report_status 报数契约，对话助手为答复契约（结构/来源标注/诚实兜底），不得把舰队语义硬套给助手岗。同一岗位 id 出现在多支包时，其 persona 必须（SHALL）跨包逐字节一致。

#### Scenario: 前缀改写被拒
- **WHEN** 深化后的 persona 不是改版前文本的前缀扩展（原文被改写或截断）
- **THEN** 基线测试与发布脚本同时拒绝，不允许上架

#### Scenario: 共享岗跨包漂移被拒
- **WHEN** 同一岗位 id 在两支包中的深化文本不一致
- **THEN** 基线测试断言失败，不允许上架

### Requirement: 转正包的上游快照不可动

provenance 为 official-adopted 的包，其技能正文是上游钉定快照——任何改版 overlay 必须（SHALL）不含 skills 键；persona 深化只许加厚包装岗的边界与纪律，不得复述或改写技能步骤。

#### Scenario: 转正技能改动被拒
- **WHEN** 转正包的 overlay 携带 skills 或发布后技能正文与上游快照不一致
- **THEN** 基线测试与发布脚本拒绝，不允许上架

### Requirement: 官方名册的完备性

官方作者名册（OFFICIAL_AUTHOR_EMAILS）是画廊 official 徽章的唯一真源；官方内容的每一位实际作者邮箱必须（SHALL）在册，否则其包在官方画廊对用户不可见。改版批新增或触及非在册作者的官方包时，必须（SHALL）先把作者邮箱补入名册并部署，再走查货架可见性。

#### Scenario: 名册缺员致隐身被拒
- **WHEN** 官方=1 接口在册的包按作者名册判 official=false（画廊不可见）
- **THEN** 名册补齐部署后走查复核，官方画廊卡数必须与官方接口支数一致

### Requirement: 改铸的外部角色必须是无触手顾问

从外部角色定义改铸而来的官方 pack 岗位，其 persona 必须（SHALL）只承诺"读—判—说"行为：判定对象由用户贴入或由工具面实际返回，且必须（SHALL）显式声明自身无执行触手、不得假装打开仓库 / 运行测试 / 扫描端口 / 读取覆盖率。上游正文里依赖 shell 或文件写的动作段必须（SHALL）改写为"建议用户在其工具链执行"的形态。每岗 persona 必须（SHALL）携带该岗所取自的上游文件出处与钉定 revision；包级 provenance 必须（SHALL）以 official-adopted 记录上游仓、许可证与钉版。

#### Scenario: 动手承诺被拒
- **WHEN** 某岗 persona 含"我来运行测试/我打开了仓库"一类未标注需用户执行的承诺
- **THEN** 基线测试拒绝，不允许上架

#### Scenario: 出处缺失被拒
- **WHEN** 某岗 persona 没有上游文件出处（仓/路径/钉版 sha）或 provenance 缺 license/revision
- **THEN** 基线测试拒绝，不允许上架

#### Scenario: 改铸纪律在文本内
- **WHEN** 检视任一评审岗的 persona 文本
- **THEN** 它声明了读—判—说契约、职责边界、按严重度带证据的输出契约，且判据来自该上游角色的专业领域而非通用套话
