## MODIFIED Requirements

### Requirement: 报数归属按岗位解析且 a2a 岗位诚实降级

报数归属 SHALL 由服务端从回合执行上下文解析（persona 岗位按当前 preset、cluster 岗位按 clusterId 定位唯一岗位），调用方 SHALL 不能指定任意岗位 id 代报。a2a 岗位因无法调用本 cell 工具，其 latest 视图 SHALL 由最近一次执行结果生成执行摘要并明确标注为非自报。

归属解析的**权威信号 SHALL 是该回合自身的执行上下文**，SHALL NOT 是运行时部署默认 preset——运行时默认 preset 按设计不由定时车道移动，读它会让驻留（parked）回合的归属必然失配。权威信号按优先级为：

1. **运行账本的在飞回合**（该回合已在执行、尚未收尾）：其岗位标识即真岗位；
2. **该回合的运行中任务记录**：其 `sourceTag` 的岗位标识即真岗位（舰队回合逐岗位物化，sourceTag 由服务端自己写入，调用方无法伪造）；
3. **回合自身的目标 preset**（任务携带值 / 驻留值）：匹配唯一 persona 岗位时采纳。

以上均不能唯一命中时，沿既有纪律诚实拒收（多个岗位共用同一 persona ⇒ ambiguous；无命中 ⇒ not-a-member），SHALL NOT 猜测、SHALL NOT 采信调用方指定的岗位 id。

#### Scenario: 服务端归属解析

- **WHEN** persona E 以「电商部」岗位身份执行回合并调用 report_status
- **THEN** 报数归属「电商部」岗位，即使请求未携带任何岗位标识

#### Scenario: a2a 执行摘要降级

- **WHEN** a2a 岗位完成一次回合
- **THEN** 其 latest 视图呈现由该回合结果生成的执行摘要，且视图标注「非自报」

#### Scenario: 驻留回合按在飞回合归属

- **WHEN** 一个 persona 岗位以驻留（parked）方式执行回合，其 persona 组合与运行时部署默认 preset 不同
- **THEN** 该回合调用 report_status 的报数归属该岗位本人，而非运行时部署默认 persona 对应的岗位

#### Scenario: 运行时默认 persona 与岗位不同不致拒收

- **WHEN** 某 cell 的运行时部署默认 preset 指向另一个 persona，而本回合岗位的 persona 是驻留挂载的
- **THEN** report_status 正常受理并归属本回合岗位，SHALL NOT 返回「not a member of any fleet」

#### Scenario: 多岗位共用同一 persona 仍诚实拒收

- **WHEN** 同一 persona 持有多个岗位，且运行中任务记录无法唯一确定本回合岗位
- **THEN** 报数被拒并说明归属歧义，SHALL NOT 任选其一记入

## ADDED Requirements

### Requirement: 报数归属结果落事实列

报数归属的判定结果 SHALL 以事实列落进回合事件记录（`member_turn_events.detail.attribution`）：`source` SHALL 取 `turn`（按在飞回合归属）、`job-sourceTag`（按运行中任务的 sourceTag 归属）、`cluster-task`（cluster 扇出归属）、`preset`（按回合目标 preset 归属）、`none`（无归属）之一，并记 `fleetId` 与 `memberId`（不可得时如实为空）。该列 SHALL 是观测来源（不可推断），使「岗位报数被拒」可从台账直接判读。

#### Scenario: 归属成功时台账可读

- **WHEN** 某回合的 report_status 被受理并归属到某岗位
- **THEN** 该回合的 member_turn_events.detail.attribution 记 source 与 fleetId/memberId，与报数卡上的岗位一致

#### Scenario: 归属失败时台账可读

- **WHEN** 某回合的 report_status 被拒（归属无命中或歧义）
- **THEN** 拒绝原因如实回到调用方，运维无需翻日志即可从回合台账判读该回合是否有归属
