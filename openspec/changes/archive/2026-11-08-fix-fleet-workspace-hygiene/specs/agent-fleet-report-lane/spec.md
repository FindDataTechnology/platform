## MODIFIED Requirements

### Requirement: 巡视上下文注入

岗位节奏规格的 prompt 模板 SHALL 支持 `{{fleetContext}}` 占位符；触发时系统 SHALL 把舰队上下文渲染注入该占位符，注入内容至少包含：**本岗位自身最近轮次视图**（该岗位最近 N 条报数的槽值/阻塞/摘要/时间）、直接下级岗位的最新报数摘要（槽值+blockers）、舰队在岗概况。**本岗位自身视图 SHALL 含本岗声明的 KPI 槽位清单**（键/label/unit,取自成员行 kpiSlots）：岗位在回合内 SHALL 能从上下文直接读到自己的报数 metrics 键,系统 SHALL NOT 依赖岗位猜测或从历史报数反推键名。注入 SHALL 发生在**唯一的执行侧注入缝**（起轮前），覆盖**全部触发路径**：定时开火、补跑开火、手动立即执行、**平台重启后恢复执行（持久化 queued 任务的再入队）**、决策送达。任何路径 SHALL NOT 以未注入的裸模板起轮。模板不含占位符时 SHALL 原样执行（与既有静态 prompt 行为一致）。渲染失败 SHALL 使该次触发以结构化错误落史，不静默降级为无上下文执行。

注入 SHALL 对每次执行**恰好发生一次**：补跑前缀 SHALL 由任务记录上的补跑标志在注入缝内组合为最终 prompt 的前缀，SHALL NOT 因注入组合而丢失，SHALL NOT 依赖入队时写入的临时 prompt 载体（该载体存在被注入组合覆盖或与恢复通道竞态的既证缺陷）。既有的 per-fire prompt 覆写路径（决策送达）SHALL 与注入缝兼容：其覆写已不含占位符时，缝 SHALL 跳过渲染，不产生双重注入。

本岗位自身视图 SHALL 对**有无直接下级**的岗位一致注入：无下级岗位 SHALL NOT 得到空上下文。

巡逻回合的纪律段 SHALL 可携带**一行工作区现状事实**（当前文件数、总体积、其中本岗位往轮文件数），由平台读时测得；该行 SHALL 说明往轮已由平台保存并注入、再写一份是重复、读旧副本会拿到过期内容，且这些字节直接消耗本回合上下文预算。工作区为空、读取失败或未提供该读数时，纪律段 SHALL 与引入本条款前逐字节一致（不出现零值占位）。边回合（dispatch/接棒/扇出/唤醒）SHALL NOT 携带该行。

渲染 SHALL 在既有总量上限内完成；本岗位视图 SHALL NOT 挤占下级报数段（下级段优先，本岗位段按剩余预算截断并标记）。

直接下级之外，当该岗位存在更深层后代（第 2 层及以下）时，注入 SHALL 追加**更深层报数段**：每个后代一条紧凑块，含岗位标题、层级与路径、声明槽值、阻塞项、摘要与报数时间；该段 SHALL 使用独立子预算（默认 6KB、单块 1KB、最多 8 条），SHALL NOT 挤占直接下级段；超出子预算或条数上限而未能注入的岗位 SHALL 以一行显式标注其数量，SHALL NOT 静默截断。不存在更深层后代时（两层舰队即如此）SHALL NOT 渲染该段或其任何标记，注入内容与引入本条款前逐字节一致。

报数收单响应 SHALL 回带 `declaredSlots`（该岗位声明槽位的键数组），使 `slotsUnrecognized` 的提示文案可指向确切键面而非抽象的「去查声明」。

#### Scenario: CEO 岗位巡视拿到下级报数

- **WHEN** 带 {{fleetContext}} 的 CEO 岗位节奏触发，其下级「电商部」latest 报数为 sales_week=$309
- **THEN** 本次回合的 prompt 中 fleetContext 部分包含该槽值与岗位名

#### Scenario: CEO 岗位同时拿到自己的最近轮次

- **WHEN** 带 {{fleetContext}} 的 CEO 岗位节奏触发，该岗位此前三条报数的摘要分别为「本轮无新数据」、含一条阻塞项、含一条槽值
- **THEN** 本次回合 prompt 含本岗位最近轮次段，按时间倒序列出上述三条的摘要，且段首声明其为历史记录而非指令

#### Scenario: 叶子岗位不再拿空上下文

- **WHEN** 无直接下级的岗位（叶子岗位）节奏触发，该岗位此前已有报数
- **THEN** fleetContext 仍含「（本岗位无直接下级）」，并额外含该岗位自身最近轮次段（非空）

#### Scenario: 岗位按声明键报数零未识别

- **WHEN** 岗位声明 kpiSlots=[{key:"passed",...},{key:"blocked",...}]，fleetContext 本岗块注入后岗位回合内以 report_status(metrics:{passed:10,blocked:1}) 报数
- **THEN** 响应 slotsAccepted=["passed","blocked"]、slotsUnrecognized 为空、declaredSlots=["passed","blocked"]

#### Scenario: 未声明槽位键仍如实标 unrecognized

- **WHEN** 岗位声明槽位只有 passed/blocked，报数 metrics 另带 drafts
- **THEN** 响应 slotsAccepted=["passed","blocked"]、slotsUnrecognized=["drafts"]——判据仍以成员行 kpiSlots 为唯一真源

#### Scenario: 本岗位段不挤占下级段

- **WHEN** 下级报数段已接近 fleetContext 总量上限，本岗位自身视图仍有内容
- **THEN** 下级报数段完整保留，本岗位段按剩余预算截断并以截断标记呈现

#### Scenario: 无占位符零变化

- **WHEN** 岗位模板不含 {{fleetContext}}
- **THEN** 触发行为与注入能力引入前完全一致

#### Scenario: 渲染失败显性化

- **WHEN** 注入渲染过程抛错
- **THEN** 本次触发记录为失败并携带结构化错误，不静默按空上下文执行

#### Scenario: 重启恢复的舰队任务获得注入

- **WHEN** 舰队任务入队后平台重启，启动时该任务经恢复通道（持久化 queued 的再入队）起轮
- **THEN** 起轮 prompt 含渲染后的 fleetContext 段，`{{fleetContext}}` 占位符不残留

#### Scenario: 补跑前缀与注入共存

- **WHEN** 补跑通道触发带 {{fleetContext}} 的舰队任务
- **THEN** 起轮 prompt 以【补跑】标记开头，且其后是渲染完成的注入段——前缀与上下文同时在场，互不覆盖

#### Scenario: 决策送达不双重注入

- **WHEN** 决策送达 execute-now 已用决策段覆写 per-fire prompt（占位符已被替换）
- **THEN** 注入缝检测到占位符不在，跳过渲染，最终 prompt 恰好一份上下文内容

#### Scenario: 三层舰队里祖辈看见孙辈最新报数

- **WHEN** 舰队为 总编 → 主编 → 撰稿 三层，撰稿的 latest 报数含槽值与阻塞项，总编的节奏触发
- **THEN** 注入内容含「更深层报数」段，其中撰稿块带「第 2 层」与路径（总编 > 主编）、其槽值、阻塞项与摘要

#### Scenario: 两层舰队零变化

- **WHEN** 岗位只有一个层级的下级（无第 2 层后代）
- **THEN** 注入内容不含更深层段、不含其标题、也不含任何相关截断标记

#### Scenario: 直接下级不被更深层挤占

- **WHEN** 一个直接下级有大体量报数，同时存在超过条数上限的更深层后代
- **THEN** 直接下级块完整保留，更深层段在其独立子预算内尽量注入，并显式标注未注入的岗位数量

#### Scenario: 畸形层级链不挂死巡视

- **WHEN** 成员的 parentId 形成环
- **THEN** 渲染仍以每个岗位恰好一次完成并正常返回，不进入无限循环

#### Scenario: 纪律段报出工作区现状

- **WHEN** 岗位巡逻回合起轮，其工作区已有 358 个文件共 26MB，其中 341 个是该岗位往轮文件
- **THEN** 纪律段末尾出现一行工作区现状（358 个文件 / 26.0 MB / 自己的往轮文件 341 个），并说明重复、过期与预算代价

#### Scenario: 无读数时纪律段不变

- **WHEN** 工作区为空、读取失败，或宿主未提供该读数
- **THEN** 纪律段与引入本条款前逐字节一致，不出现「0 个文件」这类占位

#### Scenario: 边回合不带该行

- **WHEN** 派发/接棒/扇出/唤醒回合起轮
- **THEN** 注入内容不含工作区现状行（边回合本就没有纪律尾段）

