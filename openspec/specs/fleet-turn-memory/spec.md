# fleet-turn-memory Specification

## Purpose
团队节奏回合接入永忆：把岗位回合的关键事实以零 LLM 观测存入 owner 的 u/ 记忆（`f/` 团队 project），
回合前经 `{{fleetContext}}` 注入本岗位的记忆 digest——清史重开、换防之后，岗位经验由记忆接续而非
随对话史蒸发。纯读面降级：记忆面缺席不阻塞回合。

## Requirements

### Requirement: 岗位回合关键事实以零 LLM 观测入记忆

团队节奏回合 SHALL 在回合收束时把关键事实以 L0/L1 观测 capture 进**部署命名空间分区**（add-member-knowledge-profile：成员各持 deployment 令牌，物化于 `d/<packId>/<memberId>` 根）：岗位私有事实（报数摘要、自身健康状态迁移）SHALL 落成员 own 分区，团队事实（拍板产生、拍板裁决、换防）SHALL 落 `shared` 分区；条目 SHALL 以一等 metadata 携带 `fleetId`、`memberId`、`kind`（openspec: agent-memory-foundation），标题不再承担机器寻址。事实集合仍限五类（报数摘要含槽位值、拍板产生、拍板裁决、连败/失联/恢复、换防）。capture SHALL 零 LLM、异步、预算内；capture 失败 MUST NOT 阻塞或污染回合结果；同 `(fleetId, memberId, kind, ts)` 重放 SHALL 幂等。存量 `u/<owner>/f/<fleetId>` 单项目 SHALL 停止新写，存量页原样保留可读（读面双轨过渡，见下条）。

#### Scenario: 报数入记忆可检索

- **WHEN** 客服班组一线客服完成一次节奏回合并报数
- **THEN** 一条报数观测落该成员 own 分区，metadata 带 memberId，结构化筛选可按团队/岗位过滤检索

#### Scenario: 团队拍板落 shared

- **WHEN** 一次拍板被裁决
- **THEN** 拍板观测落 `shared` 分区（团队事实跨成员可见），metadata 带 kind=decision

#### Scenario: capture 失败不阻塞回合

- **WHEN** 记忆面不可达时一轮报数收束
- **THEN** 回合结果照常交付（报数/事件照常），capture 失败只记日志与重试计数，不产生任何用户可见错误

#### Scenario: 重放幂等

- **WHEN** 同一回合事实因重试被 capture 两次
- **THEN** 记忆中仅一条观测

#### Scenario: 存量 f/ 记忆停止新写但可读

- **WHEN** 本单部署后一轮新事实产生，随后按成员查询历史
- **THEN** 新事实落部署分区；存量 `f/<fleetId>` 页不经结构化筛选外的删除或改写，仍可检索

### Requirement: fleetContext 注入本岗位记忆 digest

`{{fleetContext}}` SHALL 增「本岗位记忆」段：从**本成员 own 分区与团队 shared 分区**取 digest 并渲染（openspec: member-knowledge-profile——合流、文档共预算与挂载单点在该 spec 契约化）；渲染 SHALL 复用 `chat-memory` 的既有 digest 契约（硬预算、layer/tier/confidence 标注、被 forget 或过期条目排除、召回与生产同源），筛选 SHALL 走结构化筛选（按本成员）而非标题前缀匹配。注入 SHALL 经 provider seam：记忆面不可用或无相关记忆时 SHALL 缺席该段（显式降级，不留占位假绿）；段的预算 SHALL 计入 fleetContext 既有总量上限，超限按既有截断纪律处理并标注。

#### Scenario: 有记忆即注入

- **WHEN** 某岗位 own 分区有历史经验且 shared 有团队事实，记忆面可达
- **THEN** 该岗位回合的 fleetContext 含「本岗位记忆」段，条目带层与日期标注，预算内

#### Scenario: 无记忆或不可达即缺席

- **WHEN** 新建团队的岗位首轮开火（尚无任何记忆），或记忆面不可达
- **THEN** fleetContext 不含记忆段（不留空标题），回合照常执行

#### Scenario: 段预算受总量约束

- **WHEN** 记忆段与其余 fleetContext 段合计超过总量上限
- **THEN** 按既有截断纪律处理并标注截断，不挤掉下级报数段

### Requirement: 清史重开与换防不清岗位记忆

换防的清史重开 SHALL 只清岗位镜像会话的对话史：岗位在永忆中的历史观测 SHALL 原样保留（永不删页纪律），
新在岗者自下一回合起经记忆 digest 接续「这个岗位做过什么」；报数史与 KPI 槽位连续性照旧（既有语义）。
换防事件本身 SHALL 作为观测入记忆（新旧在岗者、是否清史），使接续者知道自己在接谁的班。

#### Scenario: 清史后经验接续

- **WHEN** 主人对某岗位执行清史重开换防
- **THEN** 岗位镜像会话重建，但下一回合的 fleetContext 记忆段仍呈现该岗位历史事实摘要与换防记录

#### Scenario: 接班者知道在接谁的班

- **WHEN** 换防后新在岗者首轮开火
- **THEN** 记忆段含最近的换防观测（前任、清史与否），不假装对话史连续
