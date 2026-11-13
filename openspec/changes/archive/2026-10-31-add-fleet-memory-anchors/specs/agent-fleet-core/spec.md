## MODIFIED Requirements

### Requirement: 岗位记忆独立于对话史存在

岗位的连续性 SHALL 由三层承载且边界清晰：对话史（岗位镜像会话，换防清史重开可清）、报数史与
KPI 槽位连续性（既有语义，任何换防不清）、**岗位记忆**（owner 永忆 `f/` 团队 project 中的历史观测，
openspec: fleet-turn-memory——永不删页，任何换防/清史/解散都不删除）。清史重开的「清」字 SHALL 限于
镜像会话对话史；解散团队 SHALL NOT 删除已入记忆的历史观测（记忆归 owner，不随资产销毁）。
回合注入侧由 fleetContext 记忆段接续（本 spec 不重复其渲染契约）。

**事实/观测分流（add-fleet-memory-anchors）**：五类事实（turn/health/decision-opened/
decision-resolved/swap）SHALL 恒落 `f/<fleetId>` 团队 project——跨承载（cell/worker/remote）合并
可查；L0 高频观测 SHALL 落各承载自己的 `d/<…>` 部署 project，MUST NOT 灌入 `f/`。

**事实页锚**：回合事实页 SHALL 在正文头部携带锚行——`turn_id`、`run_id`、`carrier`、`model`、
tokens（input/output 与计费输入=input+cached+write 三列和）、`status`——使「这笔 token 花在哪、
产出了什么」可从记忆页一跳定位台账行（台账 `trace_turn_id` 反向链不变）。锚字段缺席（如
运行时未报 usage）SHALL 如实空缺，MUST NOT 填 0 冒充观测。捕获 SHALL 保持 fire-and-forget
与降级开——记忆缺席或锚缺失 MUST NOT 阻塞或污染回合。

**换防交接锚（清史改为交接后清）**：换防（swap）SHALL 在清史重开的会话清空**之前**落一条 swap
事实，正文 SHALL 携带离任锚——末次回合的 turnId/status/model/carrier（可查时）——与新在岗者、
是否清史；清史动作本身语义不变（只清镜像会话对话史）。

#### Scenario: 解散不清记忆

- **WHEN** 主人解散一支已有历史观测的团队
- **THEN** 团队与物化任务按既有语义终止，其在 owner 记忆 `f/` project 中的观测原样保留、可检索

#### Scenario: 清史重开的边界

- **WHEN** 主人勾选清史重开换防
- **THEN** 镜像会话对话史清空重建，岗位记忆与报数史/KPI 槽位连续性均不受影响（与既有验收口径一致并扩展到记忆层）

#### Scenario: 回合事实页带锚

- **WHEN** 一个舰队成员回合结束且记忆可用
- **THEN** 该回合的 `f/` 事实页头部含 turn_id/run_id/carrier/model/tokens/status 锚行，tokens
  的计费输入为三列之和（或如实空缺）
- **AND** 凭锚行可在台账定位同一回合的结果事件行

#### Scenario: 未报 usage 如实空缺

- **WHEN** 回合结束时运行时未报 usage
- **THEN** 锚行的 tokens 段空缺而非 0，页面其余部分照常落 `f/`

#### Scenario: 换防事实先于清史落页

- **WHEN** 主人对一个有末次回合记录的岗位执行清史重开换防
- **THEN** swap 事实先于会话清空落 `f/`，正文含离任锚（末次回合 turnId/status/model/carrier）
  与新在岗者

#### Scenario: 分流——事实与观测各归其位

- **WHEN** 一个跨三承载（cell/worker/remote）成员的舰队跑了一轮多成员回合
- **THEN** 五类事实全部落在同一个 `f/<fleetId>` project（carrier 随锚可辨），而各承载的 L0
  观测留在各自 `d/` project

## ADDED Requirements

### Requirement: 舰队成本周报反哺记忆

系统 SHALL 按周为每支活跃舰队生成一页「舰队成本周报」写入其 `f/` project（kind=cost-weekly）：
内容含周内每成员的回合计数（turns/ok/failed）、估算成本合计（有价样本口径，切片③的日行估算
列）、排队等待概貌（queue_wait sum/max），并对周环比异动如实点名——成本翻倍或等待中位显著
上升的成员 SHALL 被列为 movers。生成 SHALL 降级开：计量列缺席、价目样本为零或记忆不可达时
照常出页（相应段落如实写「无样本」），MUST NOT 阻塞任何回合或失败。周报页 SHALL 为纯文本
事实页（L1），作为 L2 蒸馏的输入之一；同周重复生成 MUST NOT 删除或改写已落页面。

#### Scenario: 周报一页入 f/

- **WHEN** 一周结束且某活跃舰队有回合样本
- **THEN** 该舰队的 `f/` project 新增一页成本周报，含每成员 turns/成本/等待概貌

#### Scenario: movers 如实点名

- **WHEN** 某成员本周估算成本相对上周翻倍，或 queue_wait 显著上升
- **THEN** 周报页 movers 段点名该成员与两个周的数值；无上周样本时如实写「无对照」

#### Scenario: 全程降级开

- **WHEN** 计量列全空（旧数据）或记忆服务不可达
- **THEN** 周报段落如实写「无样本」或整页跳过（计数器呈现），任何回合不受影响
