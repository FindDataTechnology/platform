# agent-fleet-templates Specification

## Purpose

舰队的获取与传承面：模板清单（岗位骨架+槽位+节奏默认+prompt 模板+依赖清单）以 pack 形态经既有市场分发，安装即由实例化器编排建队（依赖缺位逐项降级不整体失败）；现役舰队可导出为模板（去运行时数据）再上架，形成「用—养—传」生态闭环。

## Requirements

### Requirement: 模板清单是自描述的岗位骨架

舰队模板 SHALL 以结构化清单声明：岗位骨架集（岗位名、组织关系、targetRef 类别与来源说明、KPI 槽位、节奏默认值、prompt 模板）、所需 pack/预设清单、模板元数据（名称/描述/封面）。targetRef 类别 SHALL 为以下之一：pack 预设、既有 persona、既有 cluster、既有 a2a、bot（引用 pack bot 或既有 bot，见 pack-bot-units）、tool（既有工具名）。模板 SHALL 可选携带 `orchestration` 编导声明段（边集与约束，代数与活舰队编导同源：trigger/report/dispatch/handoff/fanout/event 六种边），段内边引用的岗位 SHALL 在模板成员集内，编导形状校验（环、链深、边目标类型合法性）SHALL 与活舰队写面共用同一校验器、仅以模板成员集替代现役岗位集。清单 SHALL 不含任何凭据或所有者身份。非法清单（缺岗位名、成环、非法 cron、编导边引用成员集外岗位）SHALL 在预校验阶段以结构化错误拒绝且不上架。

#### Scenario: 合法清单过预校验

- **WHEN** 一份三部门+CEO 的模板清单提交预校验
- **THEN** 校验通过并回报岗位数与所需 pack 清单

#### Scenario: 非法清单拒绝

- **WHEN** 模板清单的组织关系成环
- **THEN** 预校验以结构化错误拒绝，指明环所在岗位

#### Scenario: 模板带编导过预校验

- **WHEN** 一份内容流水线模板声明 trigger(cron)→handoff 链与 event 边，边引用的岗位均在成员集内
- **THEN** 预校验通过，回报岗位数与边数

#### Scenario: 编导引用成员集外岗位被拒

- **WHEN** 模板 orchestration 段的一条 handoff 边引用未在 members 声明的岗位
- **THEN** 预校验以结构化错误拒绝并指名该边与缺失岗位

### Requirement: 模板以 pack 形态经市场分发

舰队模板 SHALL 作为 pack 载体经既有市场安装链分发（列表、详情、安装、凭据链
零改动语义）；应用中心 SHALL 提供「舰队」类目入口聚合模板。安装模板 SHALL
不自动启动任何回合（实例化后处于待确认启动态）。**模板供给道 SHALL 扩出离线
bundle 一路：经 `offline-pack-supply` 导入的模板 pack 与市场安装的模板 pack
SHALL 同等地出现在应用中心舰队类目、同等地可被实例化器消费，且实例化降级
规则逐条相同（依赖缺位逐项降级，不因来源不同而分叉）。**

#### Scenario: 市场安装模板

- **WHEN** 用户从市场安装「公司式舰队」模板 pack
- **THEN** 安装链走既有 pack 安装路径成功，应用中心舰队类目可见该模板为已安装

#### Scenario: 安装不自动开跑

- **WHEN** 模板实例化完成
- **THEN** 全部物化任务处于暂停态，驾驶舱提示待主人确认启动

#### Scenario: 离线导入的模板同等可用

- **WHEN** 断网机器经 bundle 导入一个含 fleet 段的模板 pack
- **THEN** 应用中心舰队类目可见该模板，实例化器以与市场来源逐条相同的规则建队与降级

### Requirement: 实例化器编排建队且依赖缺位逐项降级

实例化 SHALL 依清单编排：解析/创建目标对象（pack 预设→persona、引用既有 cluster/a2a、bot 目标→pack bot 实例或既有 bot、tool 目标→既有工具名）、建舰队与岗位、按节奏默认物化任务，并把模板 orchestration 段落到舰队对象作为其初始编导（建队即可用，主人后续改写走既有写面；落地路径 SHALL 复用写面同一校验与写入，不引入第二写源）。声明的依赖缺位（如市场 a2a 不可达、连接器未装、bot 实例不存在、工具名不解析）SHALL 使对应岗位以「等连接器/待补岗」态建队而非整体失败，缺位清单 SHALL 呈现给主人。实例化 SHALL 幂等：对同一模板重复实例化 SHALL 不产生重复舰队。

实例化对 persona/cluster 目标 SHALL 执行与建岗同源的唯一岗校验（既有活舰队在岗或同一模板内重复声明均判冲突）；冲突岗位 SHALL 以待补岗态建队而非占据第二岗或整体失败，冲突清单（含占用方舰队与岗位名）SHALL 随实例化响应呈现；a2a 目标豁免。待补岗成因（对象缺位 vs 唯一岗冲突）SHALL 在读面以可区分的方式呈现。

#### Scenario: 一键建队

- **WHEN** 主人确认启动「公司式舰队」模板实例化
- **THEN** 舰队按清单骨架建立，可实例化的岗位物化就绪，驾驶舱立即可见

#### Scenario: 依赖缺位降级

- **WHEN** 模板声明的某市场 a2a 成员当前不可达
- **THEN** 该岗位以待补岗态建立并出现在缺位清单，其余岗位正常实例化

#### Scenario: 唯一岗冲突降级

- **WHEN** 模板声明的某 persona 已在另一支活舰队在岗（或同一模板两个岗位声明同一 persona），另一用户未涉
- **THEN** 该岗位以待补岗态建队并出现在冲突清单（含占用它的舰队与岗位名），该 persona 不出现第二个岗位，其余岗位正常实例化，实例化不整体失败

#### Scenario: 冲突岗补岗恢复

- **WHEN** 唯一岗冲突降级产生的待补岗随后由主人换防补上空闲 persona
- **THEN** 岗位照常物化开跑，且原占用方的岗位与报数归属不受影响

#### Scenario: 重复实例化幂等

- **WHEN** 同一模板被再次触发实例化
- **THEN** 不产生第二支舰队，回报既有舰队标识

#### Scenario: 编导随建队落地

- **WHEN** 一份带 orchestration 段的模板实例化且全部岗位解析成功
- **THEN** 新舰队出生即携带编导边（驾驶舱立即可见边图），第一条 trigger 节奏物化照常处于待启动态

#### Scenario: bot 目标缺位降级

- **WHEN** 模板某成员的 bot 目标引用的 pack 未安装（或 cell 无该 bot 实例）
- **THEN** 该岗位以待补岗态建队并出现在缺位清单，编导边照常落地（边引用岗位 ref 而非 bot 本身），其余岗位正常实例化

### Requirement: 现役舰队可导出为模板

主人 SHALL 可把现役舰队导出为模板清单：保留岗位骨架、槽位定义、节奏规格、prompt 模板与舰队现役 orchestration 编导段，剥离运行时数据（报数史、拍板史、会话引用）与所有者身份；导出产物 SHALL 通过与上架同源的预校验。

#### Scenario: 导出保构去数

- **WHEN** 主人导出一支运行三个月的舰队
- **THEN** 导出清单含全部岗位骨架、槽位与编导边，不含任何报数记录、拍板记录与会话标识，预校验通过

#### Scenario: 导出后重装

- **WHEN** 导出的模板被安装实例化
- **THEN** 新舰队按骨架建立，节奏、槽位与编导边与导出时一致，历史数据不迁移（新舰队从零开始报数）

### Requirement: 模板新版不自动迁移现役舰队

模板 pack 发布新版 SHALL 只影响其后的新实例化；由旧版实例化的现役舰队 SHALL 不被自动迁移或改写。当现役舰队的来源模板存在更新版本时，管理面 SHALL 呈现「模板有新版」提示；对齐 SHALL 由主人显式完成（换防/调速/重建），系统不提供自动骨架合并。

#### Scenario: 新版不动现役

- **WHEN** 某模板发布 v2，而一支按 v1 实例化的舰队正在运行
- **THEN** 该舰队的岗位、节奏与槽位保持不变，仅驾驶舱呈现模板有新版提示

### Requirement: 官方种子库守恒

官方舰队模板种子 SHALL 以清单文件随仓分发（种子库目录），每份种子清单 SHALL
全部通过与上架同源的 fleet 段预校验（含 orchestration 段）；该守恒 SHALL 由
自动化测试钉住——任一官方种子清单变为非法（缺岗位名、组织关系成环、非法
cron、坏 target、编导边引用成员集外岗位）时测试 SHALL 失败。流水线叙事的
官方种子 SHALL 携带与其叙事一致的编导（如内容工厂的 trigger+handoff/dispatch
链）；入站唤醒叙事的种子 SHALL 携带 event 边。官方种子铸造上架为市场 pack
后，仓内种子文件 SHALL 仍是该模板的清单真源（再版发布以仓内文件为基准，
market 侧不产生第二个编辑入口）。**桌面安装包 SHALL 从这些仓内种子真源烘焙
一份入门种子 bundle（`installer-distribution` 的 `resources/bundles/`），
cell 首启 SHALL 把预置 bundle 登记为可导入源——登记 SHALL NOT 等于安装
（安装仍是用户显式动作/引导步内确认）；预置与市场两来源的模板语义 SHALL 一致
（同一份仓内清单真源，无第二编辑入口）。**

#### Scenario: 全库过预校验

- **WHEN** 守恒测试遍历种子库目录中的每份官方种子清单并执行 fleet 段预校验
- **THEN** 每份清单全部通过（含 orchestration 段），且自带 agents 与 fleet 段引用的 pack-preset 岗一一对应

#### Scenario: 种子腐烂被抓

- **WHEN** 种子库中任一清单被改成非法形态（如组织关系成环）
- **THEN** 守恒测试以指明具体种子文件与校验错误的方式失败

#### Scenario: 上架与仓内真源一致

- **WHEN** 一份官方种子铸造上架为市场 pack
- **THEN** 所上 pack 的 fleet 段与仓内种子文件的 fleet 段语义一致（铸造占位符补齐除外）

#### Scenario: 预置登记不等于安装

- **WHEN** 首启完成且安装包含预置入门种子 bundle
- **THEN** cell 登记该 bundle 为可导入源，pack 列表仍为空，直到用户显式确认安装

#### Scenario: 预置种子与仓内真源一致

- **WHEN** 构建期烘焙预置种子 bundle
- **THEN** 其 fleet 段与仓内种子清单真源语义一致，坏包在构建期失败

### Requirement: 模板显示字段的多语言叠加

集群模板 manifest 的 `fleet` 段 SHALL 可选携带 `i18n` 块,形状为 `{ <locale>: { name?, members?: { <memberRef>: { title?, kpiSlots?: { <slotKey>: { label? } } } } } }`,用于覆盖模板名、岗位显示名与 KPI 槽位 label 的副语言文本;每个覆盖值 SHALL 为非空字符串。模板预校验 SHALL 拒绝引用不存在成员 ref 或不存在槽位 key 的覆盖,并以结构化错误指明该 locale 与成员路径。模板 `fleet` 段内部字段(members/cadence 结构、kpiSlots 键集、orchestration 边集)形状 SHALL 与变更前完全一致;岗位 `promptTemplate` 与 persona 属内容层,SHALL NOT 进入 overlay。内置模板的 `nameKey`/`titleKey`/`labelKey` 机制 SHALL 原样保留,与 overlay 并存不互换。

#### Scenario: 双语集群模板按 locale 显示

- **WHEN** 一份模板基字段为中文场景名与岗位名,`fleet.i18n.en` 覆盖模板名与部分岗位 title,某安装面以 locale=en 展示模板
- **THEN** 被覆盖的模板名与岗位名呈现英文,未覆盖岗位与槽位 label 回落中文基字段

#### Scenario: overlay 引用未知成员被拒

- **WHEN** `fleet.i18n.en.members` 含一个模板 `members` 中不存在的 ref
- **THEN** 预校验以指明该 locale 与 ref 的结构化错误拒绝,模板不上架

#### Scenario: promptTemplate 不随语言复制

- **WHEN** 作者试图在 `fleet.i18n.<locale>` 的成员覆盖中携带 promptTemplate
- **THEN** 预校验拒绝并指明 promptTemplate 属内容层不可本地化

#### Scenario: 纯 zh 旧模板零改动

- **WHEN** 一份不含 `fleet.i18n` 的既有模板(含内置 nameKey 模板)重新提交预校验
- **THEN** 行为与本次变更前完全一致,无任何新增错误

### Requirement: 模板可声明默认参数槽

fleet 模板清单 SHALL 可声明可选的参数槽集合（`manifest.fleet.params`）：每槽含名称、类型（string/number/boolean/enum）、默认值与必填标记；声明供装作路径的参数向导消费（openspec: fleet-owner-surface）。实例化器 SHALL 按槽消费入参：提供了值的槽写入对应成员/节奏配置的映射位置，未提供且非必填的槽走声明默认值，必填槽缺失 SHALL 如实拒绝实化。模板不声明参数槽时实化行为与现状逐字节一致（全默认）。参数槽是可选扩展段——既有模板与新模板共存，不强制回写。

#### Scenario: 按槽实化

- **WHEN** 实例化一个声明参数槽的模板并提供了部分槽值
- **THEN** 提供值生效于对应配置位置，未提供的非必填槽取声明默认值

#### Scenario: 必填槽缺失拒绝实化

- **WHEN** 必填槽未提供值而调用实化
- **THEN** 实化以参数缺失分类拒绝并指名缺失槽，不建任何成员

#### Scenario: 无槽模板行为不变

- **WHEN** 实例化一个未声明参数槽的既有模板
- **THEN** 实化结果与本能力引入之前逐字节一致

### Requirement: 对外产品介绍官方种子的内容红线与词表纪律

种子库 SHALL 包含官方「产品介绍」团队种子（前台产品向导 + 五条产品线专家：一Base/十Lex/百Wire/千Facet/万Constellation），并全部通过种子库守恒预校验。该种子面向外部访客，其全部岗位 persona 文本 SHALL 遵守内容红线并由自动化测试钉住：

- SHALL NOT 含内部运营信息：部署史、主机名/节点名、成本与额度数字、网络拓扑、内部运营指标；
- SHALL 使用现行对外词表（智能体团队/小组/智能体/智能体市场），SHALL NOT 含被替换的旧词（舰队、员工框架词）；
- SHALL 在种子头部标注知识来源与日期（官网内容为真源，改版时人工同步）。

红线断言 SHALL 以种子文本为对象（不依赖运行时），任一违反使测试失败。

#### Scenario: 新种子过守恒预校验

- **WHEN** 守恒测试遍历种子库并执行 fleet 段预校验
- **THEN** 产品介绍种子的清单（前台+五专家、dispatch 星型编导、边引用成员集内岗位）全部通过

#### Scenario: 红线 probe 被测试抓住

- **WHEN** 种子任一 persona 文本被加入内部运营信息（如节点名、成本数字）或旧词（如「舰队」）
- **THEN** 红线断言测试以指明文件与违规文本位置的方式失败

#### Scenario: 来源可追溯

- **WHEN** 审阅产品介绍种子
- **THEN** 种子头部标注了各线知识的来源（官网/文档路径）与抓取日期

### Requirement: 前台分诊纪律含法律线显式路由

产品介绍团队的前台岗位 SHALL 拥有跨线关系问答职责（一·十·百·千万的层级叙事），其分诊规则 SHALL 显式包含：法律相关询问导向识律（Lex）专家——该线 SHALL 被主动推荐而非仅在被动问及时提及。分诊规则 SHALL 体现在前台岗位的 prompt 模板文本中并被红线断言测试覆盖（路由指令存在性断言）。

#### Scenario: 法律询问被导向识律

- **WHEN** 外部访客向前台询问法律相关问题
- **THEN** 前台的 prompt 分诊规则 SHALL 指示将该话题转交识律专家作答，且识律 persona SHALL 承载完整的法律产品叙事

#### Scenario: 星研与永忆的归属

- **WHEN** 外部访客询问研究/课程内容或开源自托管形态
- **THEN** 前台 persona 的知识范围 SHALL 覆盖研究/课程话术，一Base 专家 persona SHALL 覆盖开源自托管叙事——不为此单设专家岗位
