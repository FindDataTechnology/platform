# agent-fleet-core Delta — add-fleet-post-model

## MODIFIED Requirements

### Requirement: 舰队与岗位是一等对象且岗位身份稳定

系统 SHALL 以持久化对象保存舰队(Fleet:名称、所有者、状态 active|paused|archived、创建时间、舰队级默认模型 defaultModel——可空模型声明)与岗位(Member:舰队内稳定标识、岗位名、父岗位引用组成组织树、KPI 槽位声明、节奏规格、在岗者引用 targetRef、模型声明 model 与 fallbackModel——均可空)。模型声明 SHALL 不参与岗位身份:改模型、清模型 SHALL 保持岗位标识、组织位置、KPI 槽位声明与会话史不变。targetRef SHALL 支持 persona、cluster、a2a 三种目标并可在岗位生命周期内原子替换(换防);替换后岗位标识、组织位置、KPI 槽位声明 SHALL 保持不变。组织树 SHALL 允许多个顶层岗位(森林),并 SHALL 拒绝成环。

唯一在岗规则:一个 persona 或 cluster SHALL 同时只在一个岗位在岗——对已在岗对象的岗位引用(建岗或换防)SHALL 以结构化错误拒绝并指明现有岗位;a2a 目标 SHALL 允许多岗。岗位引用 SHALL 不限制目标的日常使用(角色照常对话)。

换防语义:换防 SHALL 默认延续岗位的专属会话史;换防请求可显式选择清史重开(清会话对话史,报数史与槽位连续性不受影响)。

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
- **THEN** 会话对话史清空重开,而该岗位报数史与 KPI 槽位连续性不受影响

#### Scenario: 唯一岗拒绝

- **WHEN** 主人试图把岗位 B 换防给正在岗位 A 在岗的 persona E
- **THEN** 请求以结构化错误拒绝并指明 E 已在 A 岗;岗位 A 与 B 均不变

#### Scenario: 组织树拒绝成环

- **WHEN** 用户把岗位 A 的父岗位设为其后代岗位 B
- **THEN** 请求以结构化错误拒绝,树不变

#### Scenario: 改模型不动岗

- **WHEN** 主人把「电商部」的模型从 A 改为 B、或清除为 null
- **THEN** 岗位标识、父岗位、KPI 槽位声明、会话史与物化任务均不变,仅模型声明变更

### Requirement: 舰队操作经 REST API 暴露且鉴权与既有面一致

舰队与岗位的全生命周期操作 SHALL 以 REST API(/api/fleets 前缀)暴露,鉴权与身份语义 SHALL 与既有集群/定时任务面一致(auth-on 走 forward-auth 用户,auth-off 归机器主人);用户 SHALL 只能读写自己拥有的舰队。非法输入(缺岗位名、非法 cron、未知 targetRef 类别)SHALL 以结构化错误拒绝且不落库。

模型声明的写面:建岗与改岗 SHALL 接受可选 `model` 与 `fallbackModel`(`null` = 清除,回到继承);舰队设置面 SHALL 接受可选 `defaultModel`。校验 SHALL 复用既有三闸——标识符形状、宿主模型 roster、计费车道(已绑计费才校验)——失败 SHALL 以结构化错误如实拒绝并指名违反的是哪一闸。`fallbackModel` 仅在 `model` 非空时可设;清空 `model` 时 `fallbackModel` 仍非空 SHALL 拒绝并提示先清兜底。a2a 岗位与 cluster 岗位设置模型 SHALL 拒绝(a2a 的模型归该服务的部署配置,集群岗归各成员岗位)。所有返回岗位读面的接口 SHALL 带 `model`、`fallbackModel` 原值与 `effectiveModel`——由服务端按解析链与读时 roster 计算,标注 advisory(读时与回合时 roster 可能漂移)。

#### Scenario: 越权拒绝

- **WHEN** 用户 A 请求修改用户 B 的舰队
- **THEN** 请求被拒绝且不产生任何变更

#### Scenario: 非法 cron 拒绝

- **WHEN** 创建岗位时提交非法 cron 表达式
- **THEN** 返回结构化错误,无岗位与物化任务产生

#### Scenario: 建岗带模型回显

- **WHEN** 主人建岗时带 `model: "cheap-model"`,随后 PATCH 改为 `null`
- **THEN** 建岗后岗位读面回显 `model: "cheap-model"`,PATCH 后回显 `null` 且 `fallbackModel` 同样为 null

#### Scenario: 三闸拒绝指名

- **WHEN** 主人建岗时带不在宿主 roster 里的 `model: "ghost-model"`
- **THEN** 返回结构化错误且文案指名「不在宿主模型 roster」,岗位不落库

#### Scenario: 兜底缺首选拒绝

- **WHEN** 主人 PATCH 岗位只设 `fallbackModel` 而 `model` 为空,或置 `model: null` 时 `fallbackModel` 仍非空
- **THEN** 均以结构化错误拒绝并提示兜底依赖首选,岗位模型声明不变

#### Scenario: 非 persona 岗位设模型拒绝

- **WHEN** 主人给 targetRef 为 a2a 或 cluster 的岗位设置 `model`
- **THEN** 以结构化错误拒绝并说明模型归服务部署配置/各成员岗位

#### Scenario: 读面带生效模型

- **WHEN** 岗位未声明模型而舰队设了 `defaultModel`,主人读取舰队详情
- **THEN** 岗位读面 `model` 为 null、`effectiveModel` 为舰队默认(该模型在读时 roster 中命中)

## ADDED Requirements

### Requirement: 岗位模型按解析链归位执行

每个 persona 岗位回合 SHALL 在回合开始时把运行时模型归位到解析链的第一个 roster 命中档——`[岗位 model, 岗位 fallbackModel, 舰队 defaultModel, cell 默认]`,去空去重,与 persona 归位同构、不依赖上一回合残留。解析输入 SHALL 于回合执行时从岗位/舰队表现查,不物化进任务记录。链中某档已声明但 roster 不含(写时校验不保证运行时有效)SHALL 落到下一档继续,并在回合执行记录留痕指名失效档;该回合存在报数行时 SHALL 同步记入报数 blockers。未声明(null)SHALL 安静继承,不记异常。全链无命中或 roster 为空 SHALL 使回合如实失败,不硬造模型。兜底 SHALL 仅发生在选型时;模型已入选但执行中失败(provider 故障、超时)SHALL 维持既有回合失败语义,等下个节奏自然重试,SHALL NOT 执行中换模型重跑。岗位回合用量 SHALL 按实际运行的模型计入既有 turn 记录。集群汇总回合 SHALL 以首个成功成员的解析结果模型运行。a2a 岗位回合不受解析链影响。

#### Scenario: 岗位模型归位执行

- **WHEN** 岗位声明模型 A 且运行时停在其它模型上,节奏回合触发
- **THEN** 该回合以模型 A 运行,该回合的用量记录显示模型 A

#### Scenario: 改模型下一回合生效

- **WHEN** 岗位模型从 A 改为 B,下一个节奏回合触发
- **THEN** 该回合以 B 运行(允许一次重启),不静默沿用 A

#### Scenario: 未声明岗位不被残留污染

- **WHEN** 混编舰队中岗位甲声明模型 X 跑完回合,未声明模型的岗位乙随即触发
- **THEN** 乙的回合归位到舰队默认或 cell 默认,乙的用量记录不出现 X

#### Scenario: 声明失效回落留痕

- **WHEN** 岗位声明的模型已从宿主 roster 移除,舰队设了 defaultModel,回合触发
- **THEN** 回合成功落舰队默认执行,执行记录(及存在的报数行)指名「岗位模型已失效,落舰队默认」

#### Scenario: 全链无命中如实失败

- **WHEN** 岗位与舰队均未声明模型且 cell 无可用模型,或声明档全部失效且无兜底
- **THEN** 回合以结构化错误如实失败,不虚构模型执行
