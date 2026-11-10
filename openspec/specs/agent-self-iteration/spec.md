## Purpose

自迭代闭环面：agent 用记忆章程声明自己记什么（自定义长期记忆），平台把台账/周报的异常自动转成
带证据链的提案（走既有决策车道），人批终闸后生效——「agents 决定怎么处理、平台封顶、人批把关」。

## Requirements

### Requirement: 记忆章程随 pack 声明并组成进 persona

pack manifest 的 agent 条目 SHALL 接受可选 `memory.guidance`（非空字符串，≤600 字）——该 agent
的**记忆章程**：它自己声明记什么、何时写、怎么利用召回。章程 SHALL 随 catalog entry 透传并在
persona 组成时追加为尾段「【记忆章程】」（格式不 fork OKF/不新增页面类型）；未声明 memory 的
agent SHALL 与本次变更前逐字节等价。章程随 pack 版本走（升级 pack 即更新章程），章程文本本身
SHALL 可被迭代提案修改（它是被迭代对象）。写面（memory_write_page）与召回面（回合前
fleetContext 记忆段，digest 缺席即段缺）为既有面——本需求只负责章程的声明与组成。

#### Scenario: 章程组成进 persona

- **WHEN** 一个 pack 的 agent 声明 memory.guidance 且安装后刷新目录
- **THEN** 该 agent 的 persona 预设尾段含「【记忆章程】」+ guidance 原文
- **AND** 未声明 memory 的其他 agent 的 persona 逐字节不变

#### Scenario: 章程随 pack 升级

- **WHEN** pack 升级且新 manifest 的 memory.guidance 变化
- **THEN** 目录刷新后 persona 重组（defs diff 触发子进程按既有纪律重启），章程为新版

### Requirement: 成本异常自动提案走决策车道人批生效

周报 sweep SHALL 在聚合后评估异常：成员的 queue_wait max ≥5 分钟、本周 ≥3 个独立日命中、
样本 ≥6 回合、当前解析 carrier 为 cell/auto——四条全中 SHALL 生成一条 **carrier-change 提案**
（决策车道新 item_type）：detail SHALL 携带证据链（周标识、成员、等待分布、有价成本样本、
turn_ids 抽样、proposedBy="platform:cost-anomaly"）与建议值（worker，附「需 TASK_WORKER_MAX>0
前置」说明）；同成员同型提案在途（未裁决）SHALL 跳过（去重）。提案的批准回调 SHALL 按提案
detail 应用成员 carrier（同一 updateMember 面，承载解析/fail-open 语义不变）；驳回即终。任何
一步失败 SHALL 只记计数/警告，MUST NOT 影响周报本身或任何回合。

#### Scenario: 异常命中生成提案

- **WHEN** 某成员本周 4 个独立日 queue_wait max ≥5min、样本 8 回合、carrier=cell
- **THEN** 该舰队决策车道出现一条 carrier-change 提案，detail 含证据链与建议值

#### Scenario: 证据不足不受理

- **WHEN** 成员 queue_wait 超阈但仅 2 个独立日命中（或样本 4 回合）
- **THEN** 不生成提案（周报页照常如实记录数值）

#### Scenario: 在途去重

- **WHEN** 同成员上一条 carrier-change 提案仍未裁决，本周异常再次命中
- **THEN** 不生成第二条，跳过被计数

#### Scenario: 人批生效

- **WHEN** 主人批准一条 carrier-change 提案
- **THEN** 该成员 carrier 按提案值更新（承载解析/fail-open 语义照旧），并落 decision-resolved
  事实页；驳回不产生任何变更

### Requirement: 防中毒纪律（provenance/证据/人批）

自动提案 SHALL 全链携带 provenance：proposedBy 标记生成者（platform:cost-anomaly）、证据链
（可回查的台账样本）。证据不足 MUST NOT 生成提案（阈值是受理门槛，不是参考）。提案的生效
SHALL 只经人批终闸——自动提案 MUST NOT 直接修改任何成员配置、persona 或编排；「章程文本的
修改」同样只经 pack 版本迭代或人工编辑，自动提案 MUST NOT 改写章程。

#### Scenario: provenance 全链在案

- **WHEN** 一条自动提案被创建
- **THEN** 其 detail.proposedBy="platform:cost-anomaly" 且证据链含可回查的成员/周/样本指针

#### Scenario: 自动提案永不直接生效

- **WHEN** 提案器评估完成且异常命中
- **THEN** 系统只落决策项等待人批；成员 carrier、persona 与编排零变化直至批准
