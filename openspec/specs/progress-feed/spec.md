# progress-feed Specification

## Purpose

把主人在工作区里的真实进度按轮机械进料成一页，供会话里的书记引用：在本机扫真实工作树
（各仓 HEAD 与未提交状态、openspec 在途变更与任务计数、显式 handoff 的标题与日期），
在 pod 内用 person 令牌写进团队共享分区。进料不调用语言模型、不推断意图，每条结论都带
可回指的位置（提交 sha 或仓内相对路径）；每轮只写一张页，`as_of` 停摆即视为故障信号。

## Requirements

### Requirement: 进料是确定性的且每条结论可回指

进度进料 SHALL 只由机械抽取产生：git 的 HEAD 提交与未提交状态、openspec 在途变更及其任务计数、
显式命名的 handoff 文件的标题与日期。进料 MUST NOT 调用语言模型生成摘要或推断意图。

进度页中的每一条结论 SHALL 携带可回指的位置（提交 sha 或仓内相对路径）。无法回指的内容
MUST NOT 出现在进度页里。

#### Scenario: 每条结论都能回指

- **WHEN** 进度页写下「某仓在途变更 N 个、最近提交 X」
- **THEN** 该行同时给出该仓的 HEAD sha 与相对路径，读的人能立刻回仓核对

#### Scenario: 不做推断

- **WHEN** 某仓有 7 个未提交文件
- **THEN** 进度页只记录「7 个未提交文件」这一事实，不写「正在改什么」之类的推断

### Requirement: 进料写入团队共享分区且使用成员部署令牌

进度页 SHALL 写入该舰队的共享分区（`shared`），并以**该舰队某成员的 deployment 令牌**认证。

进料 MUST NOT 使用平台令牌或 runner 令牌调用写面（该面按设计拒绝服务令牌：服务令牌不携带数据面身份），
MUST NOT 使用 owner 的 person 令牌向 `shared` 写入（那会把团队事实落到 owner 的个人根，
团队其它岗位读不到）。

#### Scenario: 服务令牌被拒时如实报错

- **WHEN** 进料器用平台令牌或 runner 令牌调用写面
- **THEN** 写面拒绝，进料状态记为 `failed` 并写明原因，MUST NOT 重试到「看起来成功」

#### Scenario: 团队岗位读得到

- **WHEN** 进度页以成员 deployment 令牌写入共享分区
- **THEN** 该舰队其它岗位的回合记忆段（own+shared）与 `memory_query` 都能检索到这些页

### Requirement: 每轮只写一张进度页，体量按轮不按仓增长

每轮进料 SHALL 只写一张进度页，标题携带该轮的 `as_of`。进料 MUST NOT 依赖覆盖/替换语义——
写面不提供按路径覆盖，重复写只会累积新页。

#### Scenario: 仓数翻倍不改页数

- **WHEN** 被纳入进料的仓从 10 个增加到 40 个
- **THEN** 每轮仍只新增一张进度页，新增的是页内段落而不是新页

#### Scenario: 同一轮重复运行

- **WHEN** 同一轮因重试被执行两次
- **THEN** 页数量按执行次数增长，状态段如实记录两次执行；MUST NOT 声称已去重

### Requirement: 进料状态必须可观测，且 `as_of` 停摆即为故障信号

每张进度页 SHALL 包含状态段：总体结果（`ok` / `partial` / `failed`）、逐源计数（仓数 / 在途变更数 /
handoff 数）、以及失败时的原因（哪一源、什么错）。

当整轮失败到写不出页时，系统 SHALL 不写任何内容——此时**上一张页的 `as_of` 停止前进**，
这 SHALL 被视为进料故障的唯一可靠信号。

#### Scenario: 部分源失败仍出页

- **WHEN** git 抽取成功但 openspec 目录不可读
- **THEN** 该轮仍写出页，状态为 `partial`，计数里 openspec 段为 0 并写明原因

#### Scenario: 整轮失败

- **WHEN** 凭据失效导致写面拒绝，整轮无法写入
- **THEN** 不产生新页；判断进料是否故障只能依据最新进度页 `as_of` 距今的时长

### Requirement: 引用进度必须报 `as_of` 与距今时长，超阈值必须声明可能过期

任何岗位（尤其书记）陈述项目进展时 SHALL 引用进度页并同时报出该页的 `as_of` 与距今时长。
当 `as_of` 距今超过配置阈值（默认 36 小时）时，陈述 SHALL 显式声明「进度可能已过期」，
MUST NOT 把「我读到的」表述成「现在如此」。

当永忆中不存在任何进度页时，岗位 SHALL 回答「进度未知：进料未接通」并说明实际可读范围。

#### Scenario: 新鲜的进度正常陈述

- **WHEN** 最新进度页 `as_of` 距今 3 小时，主人问「最近做到哪了」
- **THEN** 回答给出进展并附 `as_of`，不附加过期警告

#### Scenario: 陈旧的进度必须自曝

- **WHEN** 最新进度页 `as_of` 距今 5 天
- **THEN** 回答开头声明「进度可能已过期（上次进料 5 天前）」，再给内容

#### Scenario: 一张进度页都没有

- **WHEN** 永忆中不存在任何进度页
- **THEN** 回答「进度未知：进料未接通」，MUST NOT 用回合记忆或旧结论顶替

### Requirement: 进料范围只含元数据与显式 handoff

进料 SHALL 只读取 git 与 openspec 的元数据，以及**显式命名**为 handoff 的文档的标题与日期。

进料 MUST NOT 读取原始会话记录、聊天历史、凭据文件或任何未被显式标记为 handoff 的内容。

#### Scenario: 非 handoff 文档不被抓取

- **WHEN** 某仓 `docs/` 下有若干普通说明文档
- **THEN** 进料不把它们当作 handoff 纳入，进度页里不出现它们的标题

#### Scenario: 原始会话不进料

- **WHEN** 会话记忆目录存在
- **THEN** 进料不读取其内容；进度页中不出现任何会话原文
