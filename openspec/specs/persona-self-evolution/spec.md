# persona-self-evolution Specification

## Purpose
角色桶自进化闭环：agent 在真实回合后提议 persona 修订候选，候选过 persona A/B 评测门取得证据、owner 人批后按对象分流晋升（自建预设物化 / pack persona 经 fork 开草稿），全程提议≠生效、评测是证据不是终审、进行中会话的人格零热改。镜像 `skill-self-evolution` 的骨架与纪律。

## Requirements

### Requirement: 修订由提议产生且永不直接生效

agent SHALL 经 `persona_amend` 工具产出 persona 修订候选（修订后 persona 文本 + 依据：来源回合引用、该修订解决过什么、适用边界），候选 SHALL 落候选 store 并保持 `候选` 态——MUST NOT 直接写 custom_presets、pack、或任何在跑会话的 persona。无证据（来源回合不可溯）的候选 SHALL 被拒。提议 SHALL 受 per-owner 日预算门与同任务 debounce；候选 store SHALL 有上限（防薄候选堆积）。`persona_amend` SHALL NOT 携带任何执行语义。

#### Scenario: 提议落候选不动任何生效 persona

- **WHEN** agent 在回合收束后经 `persona_amend` 提交一份携证据的修订
- **THEN** 候选 store 新增一条候选态记录，custom_presets、pack、在跑与 parked 会话的 persona 零变化

#### Scenario: 无证据候选被拒

- **WHEN** 一份修订未引用任何来源回合或证据不可溯
- **THEN** 提议被结构化拒绝并指明证据缺失

#### Scenario: 预算与频控

- **WHEN** owner 当日提议预算耗尽或同任务重复候选触发 debounce
- **THEN** 新提议被拒且如实报因，既有候选不受影响

### Requirement: 晋升前过 persona A/B 评测门

候选 SHALL 在晋升前完成 persona A/B 对照评测：同场景任务 prompt、同模型同温、隔离 scratch root、臂名对 judge 匿名（全部沿 `memory-eval` harness 纪律），臂=现 persona 对照臂 vs 修订 persona 臂。门判据 SHALL 为：修订臂 judge 盲评不劣于对照臂且差异可解释。评测报告（臂 transcript 与 judge 判词）SHALL 随候选存档可查。评测不可用或未跑时候选 SHALL 保持候选态并如实标注「未评测」，MUST NOT 视为通过。

#### Scenario: 候选过门取得证据

- **WHEN** 一个候选完成 A/B 对照且修订臂盲评占优
- **THEN** 候选转「过门」态，评测报告随候选可查

#### Scenario: 平局或劣化不晋升

- **WHEN** 修订臂盲评劣于对照臂或 judge 不可用
- **THEN** 候选保持候选态并标注评测结论，不进入待确认晋升队列

### Requirement: 人终审晋升按对象分流

候选的晋升 SHALL 以人接受为终审（双钥匙：模型判绿是证据，人签字是终审）。人接受后按修订对象分流：**自建预设**的 persona SHALL 经既有 custom_presets CRUD 物化，旧文本 SHALL 留 lineage 审计记录（可溯可回退）；**pack 自带 persona** 的候选 MUST NOT 直改 pack——接受动作 SHALL 经既有 fork 管线开出 fork 草稿进我的创作，其发布/安装走既有管线。人 SHALL 可随时驳回候选（驳回即终结、留审计）。

#### Scenario: 自建预设修订物化留痕

- **WHEN** owner 接受一个针对自建预设的过门候选
- **THEN** 该预设 persona 按既有 CRUD 物化为修订文本，lineage 记录旧文本与候选引用

#### Scenario: pack persona 走 fork 不直改

- **WHEN** owner 接受一个针对 pack 自带 persona 的过门候选
- **THEN** 系统经既有 fork 管线开出 fork 草稿（携修订 persona），pack 本体与已装实例零变化

#### Scenario: 驳回即终结

- **WHEN** owner 驳回一个候选
- **THEN** 候选转驳回态留审计，MUST NOT 再次进入晋升队列

### Requirement: 生效节奏与会话人格稳定

修订物化 SHALL 按 preset 既有节奏生效（新会话/重铸）；进行中会话（含 parked 会话）的 persona MUST NOT 被热改。候选与评测面 SHALL 如实标注生效节奏，MUST NOT 宣称即时生效。

#### Scenario: 进行中会话人格不变

- **WHEN** 一个修订被接受物化时存在进行中或 parked 的会话
- **THEN** 这些会话的 persona 保持原文本，新铸会话读到修订文本

### Requirement: 修订对象与内容边界

修订 SHALL 只产 persona 文本候选：MUST NOT 提改模型选择、技能、工具面、运行时、安全边界、权限；MUST NOT 以任何对象提改他人资产（他人预设、他人 pack、fleet 共享岗）。修订文本 SHALL 过既有注入类闸（沿 fleet 自迭代防中毒纪律），未过闸候选 SHALL 保持候选态并如实标注。

#### Scenario: 越界提议被结构化拒绝

- **WHEN** agent 试图经 `persona_amend` 提改技能引用或工具面
- **THEN** 提议被结构化拒绝并指明越界字段

#### Scenario: 他人资产不可提改

- **WHEN** agent 试图对他人预设或他人 pack 的 persona 提交修订
- **THEN** 提议被结构化拒绝

#### Scenario: 注入类内容不过闸

- **WHEN** 一份修订文本触发既有注入类闸
- **THEN** 候选保持候选态并标注未过闸，MUST NOT 进入晋升队列
