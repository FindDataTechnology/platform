# Design: add-fleet-report-lane

## 决策总览

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 报数协议 | agent 每轮自报结构化（A 方案），工具面 `report_status` | 可控可验证；文本抽取（B）脆、记忆系统（C）不是「最新状态」语义 |
| D2 | 槽位制 | 卡片只渲染 kpiSlots 声明的 key | 卡片稳定不漂移；未声明指标不丢（进详情），允许渐进收编 |
| D3 | 归属解析 | 服务端按执行上下文（preset→member、clusterId→member 两级解析），调用方不可指定岗位 id | 信任边界：工具调用方不能代别的岗位报数 |
| D4 | a2a 降级 | 最近回合结果生成「执行摘要」，视图标注非自报 | a2a 对端调不到本 cell 工具是物理事实，诚实降级优于假装 |
| D5 | 存储 | fleets.db 新表 `member_reports`（append-only）+ 查询时 latest 聚合 | 报数史天然时序；latest 用「每岗位取最新一条」查询（量级小，无需物化视图） |
| D6 | 注入点 | cron.js enqueue 前对舰队任务做模板插值 | 单一入口（REST/WS/MCP 建的任务都经同一触发链）；非舰队任务零开销（无占位符即短路） |
| D7 | 防洪 | 每岗位每频控窗（=节奏周期的 1/2，下限 10 分钟）最多 3 条；单条 8KB | 报数风暴不能打爆存储与卡片 |
| D8 | 趋势归属 | 系统对上一条同槽值自动比对；agent 自报 delta 仅备注 | 可信度归系统——自报趋势会漂会吹 |

## report_status 契约

```
入参 { metrics?: {<slotKey>: {value: string|number, delta?: string}},
       resources?: [{name, kind, url?}],
       blockers?: [string],
       summary: string }            // summary 必填，其余可选
返回 { ok, memberTitle, slotsAccepted, slotsUnrecognized, windowResetsAt }
```

- `slotsUnrecognized` 回显未声明 key（agent 可自我纠正，不报错——宽容写入、严格呈现）。
- 注册进本地 MCP（沿 scheduling-tools 四工具的注册模式），受工具面治理并集控制；工具描述内嵌「按岗位声明的槽位上报」语义与槽位清单（运行时注入该岗位的 slots，ARG_SPEC 模式同 action-gate）。

## 归属解析链

```
回合执行上下文 → preset 有值?  → 查 members where targetKind=persona ∧ targetId=preset → 命中唯一 → 归属
                → clusterId 有值? → 查 members where targetKind=cluster  ∧ targetId=…  → 命中唯一 → 归属
                → 都未命中 → 结构化错误「非舰队成员」（HTTP 面 409 语义，工具面 error 文案）
```

一岗一人制下唯一；若同一 targetId 被多岗引用（用户自组的重叠舰队），归属歧义时拒绝并文案提示（不猜）。

## 巡视上下文注入

- 插值器输入：岗位行 + 直接下级（children）latest 报数 + 舰队概况（在岗数/成员数）+ 本岗位未决拍板数（刀3 后含批复内容，本刀只占坑：注入器读 decision 摘要接口，刀3 实现该接口前返回空段）。
- 渲染产物为纯文本段（岗位名 + 槽值行 + blockers 行 + 资源计数），截断上限 4KB/岗、总 24KB。
- 短路路径：任务无 sourceTag 或模板不含 `{{fleetContext}}` → 原样 enqueue（零开销，既有任务不受影响）。
- 渲染异常 → 该次触发记失败（结构化错误进 history），不静默空注入——「CEO 拿着空上下文巡视」比失败更危险。

## 读面与失联升级

- `GET /api/fleets/:id` 岗位对象增 `latestReport`（槽快照+at+summary+source:「self」|「derived」）与 `reportTimeline`（倒序分页）；latest 的每个槽值携带系统比对出的趋势（方向+差值，对上一条同槽值；无前值=无趋势），自报 delta 仅作 note 字段。
- 报数为自愿（grill 裁决）：不引擎强制收尾；prompt 模板与官方模板引导「收尾必报」纪律，超窗失联兜底。
- missing 判定改为：`无执行 ∈ stale窗 ∨ (latestReport.at 超窗 ∧ 该岗位曾报过数)`；响应携带 which-window 命中。被动岗不参与 missing（core 刀1 D10）。

## 前端

- 岗位卡加 KPI 槽行（值+delta 着色）与 latest summary 一行；详情抽屉放时间线 + 来源会话跳转。
- a2a 岗位卡标注「执行摘要·非自报」小徽章。

## 风险与对策

- **cluster 回合的工具面**：cluster 任务执行时成员 preset 逐个轮转，report_status 归属解析按 clusterId 而非 preset——实现时在引擎执行上下文透传 clusterId（sourceTag 已带 memberId，可反查），测试覆盖 cluster 岗位报数归属。
- **注入与 turn 竞态**：插值在 enqueue 前同步完成（毫秒级），与回合执行无竞态。
- **报数可信度**：本刀明确「自报口径」不做校验；卡片标注来源，审计走 trace（回合-工具调用链可查）。验真（对账工具）留待后续独立 change。

## 测试策略

- 模块级：槽位对齐/未声明 key 入详情、归属两级解析与歧义拒绝、频控与体积上限、注入短路/渲染/异常三路径、失联双窗判定。
- 活体级：真 persona 岗位跑一轮报数 → 卡片见值 → 换防后 latest 连续；CEO 岗位触发 → 会话首条 prompt 含下级槽值；a2a 岗位跑一轮 → 执行摘要标注。
- 回归：非舰队 cron 任务 prompt 逐字节不变（快照断言）。
