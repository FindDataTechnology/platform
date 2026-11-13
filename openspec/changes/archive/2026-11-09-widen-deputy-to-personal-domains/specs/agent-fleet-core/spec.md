## MODIFIED Requirements

### Requirement: 舰队与岗位是一等对象且岗位身份稳定

系统 SHALL 以持久化对象保存舰队(Fleet:名称、所有者、状态 active|paused|archived、创建时间、舰队级默认模型 defaultModel——可空模型声明)与岗位(Member:舰队内稳定标识、岗位名、父岗位引用组成组织树、KPI 槽位声明、节奏规格、在岗者引用 targetRef、模型声明 model 与 fallbackModel——均可空)。模型声明 SHALL 不参与岗位身份:改模型、清模型 SHALL 保持岗位标识、组织位置、KPI 槽位声明与会话史不变。targetRef SHALL 支持 persona、cluster、a2a、tool 四种目标并可在岗位生命周期内原子替换(换防);替换后岗位标识、组织位置、KPI 槽位声明 SHALL 保持不变。tool 目标(targetId 形如 `server::tool`,指向注册 MCP 服上的一个工具)SHALL 持有 JSON 参数节奏(promptTemplate 为合法 JSON 对象串,执行时作为工具参数原样传入);tool 岗的模型声明 SHALL 以结构化错误拒绝(无 LLM 回合,无处归位)。组织树 SHALL 允许多个顶层岗位(森林),并 SHALL 拒绝成环。

targetRef SHALL 另支持第五种目标 `auditor`(审计官)：只允许出现在已配置委托状的舰队中，其承载 SHALL 是受约束的 persona——工具面只含读（判例、决策历史、记忆）与结构化结论提交，MUST NOT 含写动作或对外发送工具；为 `auditor` 岗位保存含写或发送工具的工具面声明 SHALL 被服务端拒绝。未配置任何委托状的舰队新增 `auditor` 岗位 SHALL 被拒绝并提示需先配置委托状。`auditor` 目标 SHALL 遵守与 persona 相同的唯一在岗规则。

唯一在岗规则:一个 persona 或 cluster SHALL 同时只在一个岗位在岗——对已在岗对象的岗位引用(建岗或换防)SHALL 以结构化错误拒绝并指明现有岗位;a2a 与 tool 目标 SHALL 允许多岗(远程执行与无状态调用无归属歧义)。岗位引用 SHALL 不限制目标的日常使用(角色照常对话)。

换防语义:换防 SHALL 默认延续岗位的专属会话史;换防请求可显式选择清史重开(清会话对话史,报数史与槽位连续性不受影响)。**清史重开 SHALL 以「岗位下一回合在全新子进程对话上执行」为验收口径——其效果 MUST NOT 依赖运行时的会话删除能力：即使运行时不支持会话删除 RPC（静默失败被吞），清史后的下一回合也 MUST NOT 回放清史前的对话状态（生产 2026-10-25 实证：清史仅清了宿主镜像、子进程 2.36MB 会话原样续上）。镜像会话清空重建；报数史与 KPI 槽位连续性不受影响。**

#### Scenario: 建队建岗

- **WHEN** 用户创建舰队并添加一个岗位「电商部」,绑定 persona E、节奏每小时、无父岗位
- **THEN** 舰队与岗位落库,岗位出现在组织树顶层,且物化的定时任务在下一个整点触发该 persona 的回合

#### Scenario: 换防不断史

- **WHEN** 「电商部」岗位的 targetRef 从 persona E 原子替换为 persona F
- **THEN** 岗位标识、父岗位、KPI 槽位声明不变,后续节奏回合以 persona F 执行
- **AND** 岗位的历史(过往回合、既往报数与拍板)仍归属同一岗位可查

#### Scenario: 换防默认继承可选清史

- **WHEN** 主人执行换防且不勾选清史重开
- **THEN** 岗位专属会话的对话史延续,新在岗者接着既有对话执行
- **WHEN** 主人勾选清史重开
- **THEN** 岗位镜像会话清空重建,报数史与 KPI 槽位连续性不受影响
- **AND** 岗位下一回合在全新子进程对话上执行,不回放清史前的对话状态——即使运行时不支持会话删除 RPC 亦然

#### Scenario: 唯一岗拒绝

- **WHEN** 主人试图把岗位 B 换防给正在岗位 A 在岗的 persona E
- **THEN** 请求以结构化错误拒绝并指明 E 已在 A 岗;岗位 A 与 B 均不变

#### Scenario: 工具岗建岗

- **WHEN** 建岗 targetKind=tool、targetId=websearch::search、节奏每小时、promptTemplate 为 `{"query":"舰队 周报"}`
- **THEN** 岗位落库并物化 targetType=tool 的定时任务;同工具可另设一岗不被唯一岗规则拒绝

#### Scenario: 工具岗非法参数拒绝

- **WHEN** 建工具岗时 promptTemplate 不是合法 JSON 对象,或声明 model
- **THEN** 写面以结构化错误拒绝并指明原因

#### Scenario: 组织树拒绝成环

- **WHEN** 用户把岗位 A 的父岗位设为其后代岗位 B
- **THEN** 请求以结构化错误拒绝,树不变

#### Scenario: 改模型不动岗

- **WHEN** 岗位「电商部」的模型声明从 glm-4.7 改为 deepseek-v4.1-flash
- **THEN** 岗位标识、父岗位、KPI 槽位声明与目标不变;该岗下一回合以新声明执行

#### Scenario: 新增审计官岗位

- **WHEN** 主人在已配置委托状的舰队中新增一个 `targetRef.targetKind=auditor` 的岗位
- **THEN** 岗位创建成功，其工具面只含读与结论提交

#### Scenario: 审计官岗位拒绝写工具

- **WHEN** 有人尝试为 `auditor` 岗位保存一个包含写工具或对外发送工具的工具面
- **THEN** 服务端拒绝该保存并说明审计官不得持有写权限

#### Scenario: 未配置委托状的舰队不能设审计官

- **WHEN** 一个未配置任何委托状的舰队尝试新增 `auditor` 岗位
- **THEN** 创建被拒绝，并提示需先配置委托状
