# agent-decision-independence Specification

## Purpose
判定一个结论能否被引用为判例，由**结构独立性**判定，而不是由签字人的身份判定：提案者、裁决者、
验证者三者互不相同，验证者与原提案盲面且模型不同，签名链上不存在环。人因此从「必经签字人」变成
「可介入的审计位」——系统的主要执行层由 agent 与 agent 团队承担，人读得到、停得下、撤得回。

## Requirements

### Requirement: 可引用性由独立性图判定

系统 SHALL 对每条可作判断依据的记录计算一次独立性结论，结论 SHALL 至少包含
`proposer` / `decider` / `grader` 三个坐标与一个 `ok` 布尔。

**两个判定分开算，因为它们是两个问题**：`ok` 回答「这是不是自己给自己背书」，`verified` 回答
「有没有人真的复核过」。把两者压成一个布尔，会让复核做得最认真的记录反而被判得最严。

`ok` 成立当且仅当：

- 提案者与裁决者不同（`proposer ≠ decider`）；
- 裁决者与验证者不同（`decider ≠ grader`）；
- 签名链上不存在环：沿 `proposer → decider → grader` 的坐标链不回到链上任一已出现坐标。

`verified` 成立当且仅当存在验证者，且：

- 验证者所用模型与裁决者所用模型不同；
- 验证者的输入是盲的：只含待比较的产物与其判定标准，不含提案者的叙述、动机或来历。

独立性 `ok` MUST NOT 被任何身份的声明所替代：记录中出现「owner」「admin」等字样 SHALL NOT
使 `ok` 变为真。缺少验证者的记录 SHALL 计算为 `ok` 成立但 `verified: false`，MUST NOT 因此被判为
独立性不成立。有验证者但验证不成立的记录（同模型或非盲）SHALL 同样为 `ok` 成立、`verified: false`，
MUST NOT 被判为独立性不成立。

#### Scenario: 三个位置被同一支舰队占满

- **WHEN** 一条记录的 `proposer`、`decider`、`grader` 分属三个不同的成员标识，但三者回溯到同一支舰队且链上出现重复坐标
- **THEN** 独立性判为不成立，该结论不得进入判例集，理由是「签名链成环」而非「等级不足」

#### Scenario: 身份字样不构成独立性

- **WHEN** 裁决记录的目标字段里写着 `owner`，但该记录的 `proposer` 与 `decider` 是同一坐标
- **THEN** 独立性判为不成立，不得因身份字样而进入判例集

#### Scenario: 无验证者时为未验证而非不成立

- **WHEN** 一条记录有 `proposer` 与 `decider` 且两者不同，但没有第三方验证者
- **THEN** 独立性 `ok` 成立且 `verified: false`，该结论可进入判例集并标注「未经独立验证」

#### Scenario: 复核不合格降为未验证而非自裁

- **WHEN** 一条记录有三个互不相同的坐标，但验证者用的是与裁决者相同的模型，或看得见提案者的推荐结论
- **THEN** 独立性 `ok` 仍成立、`verified: false`，结论标注「未经独立验证」；MUST NOT 因此判为 `agent-self`

### Requirement: 判例引用按等级而非按主体

系统 SHALL 以等级集合判定一条记录能否被引用为判例。可引用的等级 SHALL 为
`owner-authored`、`owner-approved`、`agent-independent`、`agent-independent-unverified`；
`agent-self` SHALL NOT 可引用。判例检索 MUST NOT 以主体身份（例如是否由主人产生）作为过滤条件，
且 MUST NOT 因某等级由 agent 产生而排除它。

#### Scenario: agent 独立裁定的结论可被后续引用

- **WHEN** 常务岗在独立性成立的前提下裁决了一条同类事项，随后另一个岗位判断前检索判例
- **THEN** 该条出现在判例集中，并带上等级与是否经独立验证的标注

#### Scenario: 自裁结论不出现在判例集

- **WHEN** 一次裁决的 `proposer` 与 `decider` 是同一坐标
- **THEN** 该条以 `agent-self` 入账，不出现在任何判例检索结果中，仅可用于行为一致性统计

### Requirement: 判定记录携带整条签名链

每条裁决记录 SHALL 持久化完整签名链，至少包含：提案者、裁决者、裁决者所用模型、验证者、
验证结论、独立性结论（含每个子条件的成立情况）、裁决依据原文。反事实说明 SHALL 仅在
该判定的风险档属于不可降级档（`destructive` / `publish`）时生成与保存；其余档位 MAY 省略。

签名链 SHALL 可被审计面按记录读取，且 MUST NOT 依赖提案者自述的来历。

#### Scenario: 发布类判定带反事实

- **WHEN** 一次判定的风险档是 `publish`
- **THEN** 记录包含反事实说明，与盲比结果一并可读

#### Scenario: 日常判定不带反事实但仍完整

- **WHEN** 一次判定的风险档是日常档
- **THEN** 记录不含反事实字段，但签名链、独立性结论与裁决依据齐备

### Requirement: 人的位置是可介入而非必经

系统 SHALL NOT 要求人类主体作为晋升或裁决生效的必要条件。对非不可降级档的判定，独立性成立即
SHALL 生效。对不可降级档（`destructive` / `publish`），系统 SHALL 在生效后保留一个可撤销窗口，
人类主体可在窗口内撤销，撤销 SHALL 记录为独立的审计事件。

人类主体 SHALL 始终可以：读取任意判定的完整签名链、暂停一支团队的后续回合、在撤销窗口内撤销
不可降级档的判定。上述能力 MUST NOT 依赖于其是否参与过该判定的产生过程。

#### Scenario: 无人类参与的学习闭环

- **WHEN** 一支团队的一个岗位提议技能改进，另一支团队独立验证通过，独立性成立
- **THEN** 该技能晋升并物化生效，全程无人类主体点击任何按钮，且事后可在审计面读到整条链

#### Scenario: 人在撤销窗口内撤销发布类判定

- **WHEN** 一次 `publish` 档判定在独立性成立后生效，人类主体在撤销窗口内撤销
- **THEN** 该判定被回滚，撤销作为一个独立审计事件入账，原判定记录不被改写
