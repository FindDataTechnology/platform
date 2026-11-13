# skill-self-evolution Specification

## Purpose

技能自进化闭环：agent 在真实回合后提议可复用的技能候选，候选过技能 A/B 评测门取得证据、
经人接受后经既有物化链热载晋升——「AI 总结、AI 提议、评测举证、人终审」。纪律锚点：
候选永不直接生效（提议≠落库）、评测是证据不是终审（双钥匙）、永不删页只 lineage（supersedes）。

## ADDED Requirements

### Requirement: 候选由提议产生且永不直接生效

agent SHALL 经 `skill_propose` 工具产出技能候选（name/description/body/依据/适用边界），
候选 SHALL 落候选 store 并保持 `候选` 态——MUST NOT 直接写 custom_skills、MUST NOT 物化、
MUST NOT 影响任何在跑回合的工具面。候选 SHALL 携带证据（来源回合引用、该路径解决过什么）；
无证据的候选 SHALL 被拒。提议 SHALL 受 per-owner 日预算门与同任务 debounce；候选 store SHALL
有数量上限，超限拒绝并提示清理。pack 自带技能（originPackId 面）与平台运行时/安全边界
SHALL NOT 成为候选对象——`skill_propose` 对此类目标 SHALL 结构化拒绝。

#### Scenario: 提议落候选不动技能库

- **WHEN** agent 在一次成功的报表任务后提议「季度报表口径对齐」技能
- **THEN** 候选 store 新增一条候选态记录，custom_skills 与物化目录零变化，在跑回合工具面不变

#### Scenario: 对 pack 技能提议被拒

- **WHEN** agent 试图对某个 pack 自带技能提议改版
- **THEN** 工具以结构化错误拒绝并指名该技能属 pack 面，不可自进化

#### Scenario: 预算门与上限

- **WHEN** owner 当日提议预算耗尽或候选 store 达上限
- **THEN** 提议被延迟或拒绝并如实提示，不静默丢弃

### Requirement: 晋升前过技能 A/B 评测门

候选 SHALL 在晋升前完成技能 A/B 对照评测：同场景任务 prompt、同模型同温、隔离 scratch root
（不触生产数据）、臂名对 judge 匿名——全部沿 `memory-eval` 既有 harness 纪律。臂形状：
无该 skill 对照臂 vs 携该 skill 臂；`supersedes` 候选 SHALL 另含旧 skill 臂（三臂）。
门判据 SHALL 为：携 skill 臂 judge 盲评不劣于对照臂（supersedes 候选另需不劣于旧 skill 臂），
评测报告（原始 transcript 与 judge 判词）SHALL 随候选存档可查。评测不可用或未跑时候选 SHALL
保持候选态并如实标注「未评测」，MUST NOT 视为通过（判据没跑成≠通过，沿 laneError 分界教训）。

#### Scenario: 候选过门取得证据

- **WHEN** 一个候选完成 A/B 对照且携 skill 臂盲评占优
- **THEN** 候选转「过门」态，评测报告（含臂 transcript 与判词）随候选可查

#### Scenario: 劣化不晋升

- **WHEN** 携 skill 臂盲评劣于对照臂或与旧 skill 臂相比退步
- **THEN** 候选保持候选态并标注评测结论，不进入待确认晋升队列

#### Scenario: 评测没跑成不算过门

- **WHEN** 评测因上游不可达中断
- **THEN** 候选保持候选态并如实标注「未评测（原因）」，接受入口对该候选不可用

### Requirement: 人终审晋升与 lineage 留痕

「过门」候选 SHALL 进入主人的待确认面；晋升 SHALL 仅由人触发：接受即经既有 custom_skills CRUD
写入并物化热载（零重启），驳回即终结（留审计，不可复活——重新提议是新候选）。`supersedes` 候选
晋升时 SHALL 在被取代 skill 上记录 lineage（被谁、何时、依据哪份评测），旧正文保留可溯；
lineage SHALL 呈现在技能详情。晋升/驳回 SHALL 逐条留审计（谁、何时、依据哪份评测报告）。

#### Scenario: 接受即热载

- **WHEN** 主人对一个过门候选点接受
- **THEN** custom_skills 新增该技能并物化，下一个回合工具面即可用，全程零重启

#### Scenario: supersedes 晋升留 lineage

- **WHEN** 一个标记 supersedes 的候选被接受
- **THEN** 旧 skill 标注被取代（指向新技能与评测报告），新技能生效，旧正文仍可查

#### Scenario: 驳回即终结

- **WHEN** 主人驳回一个过门候选
- **THEN** 候选终结留审计，不再出现在待确认面；同主题新路径须重新提议
