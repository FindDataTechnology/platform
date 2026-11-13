# agent-fleet-report-lane delta

## MODIFIED Requirements

### Requirement: 巡视上下文注入

岗位节奏规格的 prompt 模板 SHALL 支持 `{{fleetContext}}` 占位符；触发时系统 SHALL 把舰队上下文渲染注入该占位符。注入 SHALL 发生在**唯一的执行侧注入缝**（起轮前），覆盖**全部触发路径**：定时开火、补跑开火、手动立即执行、**平台重启后恢复执行（持久化 queued 任务的再入队）**、决策送达。任何路径 SHALL NOT 以未注入的裸模板起轮。模板不含占位符时 SHALL 原样执行（与既有静态 prompt 行为一致）。渲染失败 SHALL 使该次触发以结构化错误落史，不静默降级为无上下文执行。

注入 SHALL 对每次执行**恰好发生一次**：补跑前缀 SHALL 由任务记录上的补跑标志在注入缝内组合为最终 prompt 的前缀，SHALL NOT 因注入组合而丢失，SHALL NOT 依赖入队时写入的临时 prompt 载体（该载体存在被注入组合覆盖或与恢复通道竞态的既证缺陷）。既有的 per-fire prompt 覆写路径（决策送达）SHALL 与注入缝兼容：其覆写已不含占位符时，缝 SHALL 跳过渲染，不产生双重注入。

本岗位自身视图 SHALL 对**有无直接下级**的岗位一致注入：无下级岗位 SHALL NOT 得到空上下文。

渲染 SHALL 在既有总量上限内完成；本岗位视图 SHALL NOT 挤占下级报数段（下级段优先，本岗位段按剩余预算截断并标记）。

#### Scenario: CEO 岗位巡视拿到下级报数

- **WHEN** 带 {{fleetContext}} 的 CEO 岗位节奏触发，其下级「电商部」latest 报数为 sales_week=$309
- **THEN** 本次回合的 prompt 中 fleetContext 部分包含该槽值与岗位名

#### Scenario: CEO 岗位同时拿到自己的最近轮次

- **WHEN** 带 {{fleetContext}} 的 CEO 岗位节奏触发，该岗位此前三条报数的摘要分别为「本轮无新数据」、含一条阻塞项、含一条槽值
- **THEN** 本次回合 prompt 含本岗位最近轮次段，按时间倒序列出上述三条的摘要，且段首声明其为历史记录而非指令

#### Scenario: 叶子岗位不再拿空上下文

- **WHEN** 无直接下级的岗位（叶子岗位）节奏触发，该岗位此前已有报数
- **THEN** fleetContext 仍含「（本岗位无直接下级）」，并额外含该岗位自身最近轮次段（非空）

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
