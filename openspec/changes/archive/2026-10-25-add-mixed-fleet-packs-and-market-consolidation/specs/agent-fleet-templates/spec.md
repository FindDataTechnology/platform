# agent-fleet-templates Delta

## MODIFIED Requirements

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

### Requirement: 官方种子库守恒

官方舰队模板种子 SHALL 以清单文件随仓分发（种子库目录），每份种子清单 SHALL 全部通过与上架同源的 fleet 段预校验（含 orchestration 段）；该守恒 SHALL 由自动化测试钉住——任一官方种子清单变为非法（缺岗位名、组织关系成环、非法 cron、坏 target、编导边引用成员集外岗位）时测试 SHALL 失败。流水线叙事的官方种子 SHALL 携带与其叙事一致的编导（如内容工厂的 trigger+handoff/dispatch 链）；入站唤醒叙事的种子 SHALL 携带 event 边。官方种子铸造上架为市场 pack 后，仓内种子文件 SHALL 仍是该模板的清单真源（再版发布以仓内文件为基准，market 侧不产生第二个编辑入口）。

#### Scenario: 全库过预校验

- **WHEN** 守恒测试遍历种子库目录中的每份官方种子清单并执行 fleet 段预校验
- **THEN** 每份清单全部通过（含 orchestration 段），且自带 agents 与 fleet 段引用的 pack-preset 岗一一对应

#### Scenario: 种子腐烂被抓

- **WHEN** 种子库中任一清单被改成非法形态（如组织关系成环）
- **THEN** 守恒测试以指明具体种子文件与校验错误的方式失败

#### Scenario: 上架与仓内真源一致

- **WHEN** 一份官方种子铸造上架为市场 pack
- **THEN** 所上 pack 的 fleet 段与仓内种子文件的 fleet 段语义一致（铸造占位符补齐除外）
