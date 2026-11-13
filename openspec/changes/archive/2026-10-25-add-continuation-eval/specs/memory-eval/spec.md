# memory-eval Specification

## ADDED Requirements

### Requirement: 接续评测是三臂对照实验且臂形状钉死

接续评测 SHALL 以三臂对照运行：**无记忆臂**（续作任务 prompt 原样）、**标题臂**（注入前史页面的标题+日期列表——集群回合 hook ① 的生产形状）、**digest 臂**（注入按渲染契约生成的记忆块）。同一场景的三臂 SHALL 使用相同任务 prompt、相同被评模型与温度、相同 judge 与评分口径，唯一差异是注入块。臂标签在送评时 SHALL 匿名化（judge 不可见臂名）。评测 SHALL 在隔离的 scratch root 上运行（真调度器、真 sidecar、真词元车道），不触碰生产数据。

#### Scenario: 同场景三臂仅注入块不同

- **WHEN** 一个场景跑完三臂后比对三份送评 transcript
- **THEN** 任务 prompt 逐字节相同、模型与采样参数相同，唯一差异为注入块（无 / 标题列表 / digest）

#### Scenario: 臂名对 judge 不可见

- **WHEN** judge 收到送评 transcript
- **THEN** transcript 中不含臂名或可反推臂身份的标记

### Requirement: digest 渲染契约——预算、召回、标注、排除

digest 注入块 SHALL 由一个可独立单测的渲染器生成，并满足：**硬预算**（可配置、默认上限 1,500 tokens，超预算按优先级截断——open handoffs 通知段最先保留）；每条记忆条目 MUST 带 layer（L1/L2）、confidence、产生日期；块内 MUST 含 open handoffs 通知段（有 open 交接时）；被 forget 或已过 expires_at 的条目 MUST NOT 进入渲染；召回来源 MUST 走与生产候选检索同一条代码路径（向量优先、关键词兜底），不得为评测另造检索实现。

#### Scenario: 预算硬截断保 handoffs 段

- **WHEN** 召回结果总量超过预算且存在 open handoffs
- **THEN** 渲染块总长不超预算，handoffs 通知段完整在场，被截断的是优先级最低的 L2 条目

#### Scenario: 被忘条目不进 digest

- **WHEN** 渲染输入含一枚已 forget 的 experience
- **THEN** 该条目不出现在渲染块中

#### Scenario: 召回路径与生产同源

- **WHEN** digest 臂在某场景执行召回
- **THEN** 候选检索调用的检索实现与蒸馏候选检索为同一模块，参数差异仅限 top-k

### Requirement: LLM-judge 双指标盲评

评测 SHALL 以双指标评分：**重推导度**（agent 是否重推了本可从注入记忆知道的背景；分高=重推导少）与**首步正确性**（声称的下一步与场景期望背景集合的一致性；分高=更一致）。judge SHALL 输出结构化分数与逐条依据（引用 transcript 原文）；judge 模型 SHALL 钉扎（与被评模型不同实例调用，可同车道）；每场景每臂的 judge 调用 MUST 记录 token 消耗并入账。

#### Scenario: 分数带可核查依据

- **WHEN** judge 对一份 transcript 完成评分
- **THEN** 输出含两个指标的数值分与引用原文的依据段，可被人工抽检复核

### Requirement: 硬门判定与基线入档

评测 SHALL 在全量场景上做场景级配对比较并输出裁决：**digest 臂显著优于无记忆臂**（两指标的配对胜率与平均分差阈值在 design 定死）即过门（v4 注入线的解锁依据）；标题臂仅作生产现状基线参照，不参与门的判定。每次全量运行的分数、裁决、token 消耗 SHALL 落档（含被评/judge 模型名与场景集版本），构成可回溯的基线序列。S0 生产基线（交接认领率、调用分布）SHALL 与实验指标分列记载，不得混入实验裁决。

#### Scenario: 过门裁决可复算

- **WHEN** 拿到一次全量运行的场景级分数明细
- **THEN** 仅凭明细与 design 阈值可复算出相同裁决，无需重跑

#### Scenario: 不过门同样入档

- **WHEN** digest 臂未达显著阈值
- **THEN** 裁决为不过门，分数与差值仍完整落档，作为渲染/召回迭代的对照起点

### Requirement: 续作场景来源真实且脱敏可溯

续作场景 fixtures SHALL 从生产记忆根的真实数据构造：每场景含前史快照（L0 观测序列、L1 交接/笔记、已产 L2 页）、续作任务描述、期望背景集合（判定「本可知道」的基准）。生产内容进仓 MUST 过与 capture 同款的脱敏管线，且每个场景 MUST 标注来源 root/project 与脱敏复核状态；场景集 SHALL 覆盖至少三个生产 project、每 project 不少于四个场景。

#### Scenario: 场景带溯源与复核标记

- **WHEN** 打开一个场景条目
- **THEN** 可见来源 root/project 标注与脱敏复核状态字段，未复核的场景不得进入全量运行

#### Scenario: 期望背景集合可判重推导

- **WHEN** judge 评估无记忆臂 transcript 的重推导度
- **THEN** 判定基准是场景自带的期望背景集合，而非 judge 自行猜测
