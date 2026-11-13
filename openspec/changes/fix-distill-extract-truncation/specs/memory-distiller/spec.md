## MODIFIED Requirements

### Requirement: 调度按会话边界触发且去抖，预算按 owner 限额

调度器 SHALL 在会话边界（session-end / stop 批末）标记待蒸馏 scope 并去抖合并，辅以定时批兜底扫描 cursor 落后的 scope；同一 scope MUST NOT 并发蒸馏。每 owner 的蒸馏用量 SHALL 按日限额（可经部署配置调整），用量按 owner 归因入账；超限即停、记录缺口，次日自动续；限额 MUST 在运行过程中持续生效（逐片检查、增量记账），不得只在运行开始前检查一次。计费真源不变（sub2api / 词元车道账单），本预算为护栏非对账。

蒸馏范围 SHALL 覆盖包根（`d-`）与人根（`u-`）：人根受部署级开关 `FD_MEMORY_DISTILL_U`（`=0` 时完全不进触发与扫描，行为与未启用字节等同，默认启用）。蒸馏原料 SHALL 含会话观测、handoff、以及人根的 note 页（以 observation 形状合成条目，`tool=memory_write_page`，含标题与正文摘录），note 游标随蒸馏推进、不重蒸馏。兜底扫描对无观测的人根 SHALL 经页索引发现 project。

MCP 写面成功写入蒸馏原料（note 页、handoff）SHALL 即时通知调度器标记该 project 待蒸馏（进程内可选回调，未接线方零行为变化），人根走短去抖（约 60 秒，对比包根会话边界的 5 分钟）——写后蒸馏在约 2 分钟内可用；通知与兜底扫描相互独立（通知丢失不丢原料，游标幂等防重蒸馏）。

**失败不得静默跳过材料**：当一次抽取被判定为「可能截断」或引擎报错时，该批次的游标 MUST NOT 前进，材料 MUST 在下一轮重试；只有确实完成抽取（无论是否产出页面）的批次才允许推进游标。

#### Scenario: 会话结束去抖触发

- **WHEN** 同一 scope 短时间内多个会话相继结束
- **THEN** 去抖窗口内的会话合并为一次蒸馏，cursor 一次前进

#### Scenario: 日预算超限即停次日续

- **WHEN** 某 owner 当日蒸馏用量达到限额
- **THEN** 该 owner 的蒸馏停止并记录缺口，L0/L1 不受影响，次日从保留的 cursor 自动继续

#### Scenario: 人根 note 进蒸馏且不重蒸馏

- **WHEN** 某人根 project 存在 note 页（含蒸馏后新写的 note）且兜底扫描周期到达
- **THEN** 新 note 以 observation 形状条目进入蒸馏原料，产出 L2 后 note_cursor 前进；再次扫描不重复提交已游标过的 note

#### Scenario: 部署开关关闭零行为

- **WHEN** `FD_MEMORY_DISTILL_U=0` 时兜底扫描与触发到达
- **THEN** 人根不进入待蒸馏集合（无蒸馏调用、无 token 消耗），包根蒸馏行为不变

#### Scenario: 写触发短去抖

- **WHEN** 某 u- 根经 MCP 成功写入一条 note
- **THEN** 该 project 在去抖窗口（约 60 秒）后被标记待蒸馏并在约 2 分钟内蒸馏（对比兜底扫描的 10 分钟周期）；60 秒窗口内的连续写入合并为一次蒸馏

#### Scenario: 截断的批次不被跳过

- **WHEN** 某批次的抽取输出顶到完成度上限、被判定为可能截断
- **THEN** 该批次先以更小分片重试一次；仍被判定截断则记录 gap 并保持游标不动，下一轮重新提交同一批材料

#### Scenario: 正常空产出仍然推进

- **WHEN** 抽取完整返回且确实没有可提炼内容（未触顶、无解析错误）
- **THEN** 游标正常前进，不记 gap，不重试

## ADDED Requirements

### Requirement: 蒸馏成本与产出必须可解释

蒸馏 SHALL 在运维指标面暴露按引擎阶段（extract / reconcile / judge 等）的调用次数与 prompt/completion token 累计，使「钱花在哪一段」可读；SHALL 同时暴露用于判定产出健康度的比率（每次运行的送检材料数与实际落库页数）。指标面 MUST NOT 把「截断导致的空产出」与「材料确实无可提炼」计成同一类。

#### Scenario: 阶段分布可读

- **WHEN** 运维读取运维指标面
- **THEN** 能看到每个阶段的调用次数与 prompt/completion token 累计，并据此判断哪一阶段是主要成本

#### Scenario: 截断比例可读

- **WHEN** 运行历史中存在顶到完成度上限的抽取
- **THEN** 指标面给出该情形的次数或占比，使「是否在丢产出」无需翻日志即可判断

### Requirement: 固定成本必须按材料数摊薄

引擎的单次调用包含一份与材料数基本无关的固定提示词开销。系统 SHALL 以「每次调用承载的材料数」作为成本调节手段，并 MUST 在此调整之前先具备「截断可见且可退避」的能力——分片加大 SHALL NOT 在截断检测缺失的情况下进行。

#### Scenario: 摊薄前后按每条材料计价

- **WHEN** 调整每次调用承载的材料数
- **THEN** 以「每条材料的 token 成本」而非「每次调用的 token 成本」评估收益，因为固定提示词被摊薄的是前者

#### Scenario: 缺少截断检测时不得加大分片

- **WHEN** 截断检测与退避尚未生效
- **THEN** 分片参数保持现状，不以「省调用次数」为理由放宽
