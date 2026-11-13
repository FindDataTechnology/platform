# Design: add-fleet-decision-lane

## 决策总览

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 队列定位 | 舰队主人单人队列（cell 所有者） | 舰队是 cell 级私产；角色体系多审批人留 v2（role-system 可后挂） |
| D2 | 状态机 | open→approved/rejected→delivered；open→expired→(重开)→open | 最小闭集；delivered 是送达事实不是新决策态；expired 保留可重开=不静默丢 |
| D3 | 送达机制 | 复用刀2 注入器（决策段独立分段）+ 引擎 runTaskNow 做立即执行 | 零新派发路径；批复-执行时序天然由回合边界承载 |
| D4 | 并发裁定 | sqlite 单写 UPDATE … WHERE state='open' 乐观并发（首裁定局） | clusters/missions 同款模式 |
| D5 | 防洪 | 每岗位每日 ≤10 条、舰队队列 open 上限 50、超限整队只读警示 | 拍板被刷爆=创始人入口瘫痪，防洪优先于表达自由 |
| D6 | 与萬星 mission 关系 | 互不改动；同形不共享 | mission awaiting_approval 是 planner 契约内嵌状态机，动它风险大；同形生产者接后续独立 change |
| D7 | 过期归属 | 舰队级 decisionPolicy.expiryHours（默认 72，0=关闭）；岗位的建议时限仅展示 | agent 不给主人定死线（否则可赶在被驳前刷过期）；主人策略统一可预期 |
| D8 | 处置权 | v1 全人批（CEO 只附建议） | 代理决策需信任积累+审计面，v2 再开 |

## DecisionItem 模型（fleets.db 新表）

```
decision_items { id, fleetId, memberId, question, options JSON[{value,label}],
                 severity: low|normal|high, suggestedDeadline?(仅展示), recommendation?,
                 state: open|approved|rejected|expired|delivered,
                 resolution JSON{kind: approve|reject|amend, choice?, note?, by, at},
                 sourceSessionId, submittedAt, deliveredAt?, deliveredSessionId? }
fleets 表增列 decisionPolicy JSON{expiryHours(默认72,0=关), dailyCapPerMember(默认10)}
```

- 改批 = resolution.kind=amend（choice 为修正值），对 agent 语义等同 approve+注记；问题文本不可改（改问题=新拍板）。
- 重开 = expired→open（主人显式动作，不自动循环过期）。

## escalate 契约

```
入参 { question: string(≤500), options: [{value,label}]（2..6 项）,
       severity: low|normal|high, suggestedDeadline?: string(人读建议，仅展示), recommendation?: value }
返回 { ok, itemId, queuePosition, dailyRemaining }
```

归属解析复用刀2 链（preset/clusterId→member）；a2a 岗位物理上不能调用（同刀2 诚实边界——a2a 成员无拍板通道，其输出里的建议由同舰队 persona 岗位转提）。

## 送达流水

```
批复落库(approved) --下一节奏--> 注入器决策段含该项 --> 回合完成 --> 标 delivered
        '--立即执行--> runTaskNow(member 的物化任务) --> 同上
岗位消失: 送达悬挂; 补岗后首次节奏完成送达 (spec「待岗位恢复」)
```

- delivered 标记挂在回合完成回调（engine onFinished 已有钩子面），按 memberId+itemId 挂账幂等。
- 注入器决策段内容：问题+裁定+所选值/驳回理由+批注；一条回合最多注入 5 条待送达（按批复时间序），超出滚动到下一轮——防单轮 prompt 爆炸。

## API 面（/api/fleets/:id/decisions）

```
GET   /?state=open|all   列表（含来源岗位/会话链接/未决计数）
POST  /:itemId/approve   {choice, note?}
POST  /:itemId/reject    {note}
POST  /:itemId/amend     {choice, note?}
POST  /:itemId/reopen    （仅 expired）
POST  /:itemId/execute-now  （仅 approved，触发 runTaskNow）
```

主人归属校验同舰队其他写路径。

## 通知与徽章

- unread 派生：`openCount > 0 ∧ 上次查看时间 < 最新 open 提交时间`（会话 unread 同型语义，客户端派生零服务端状态）。
- 微信信封：复用 scheduled-task-notifications 的 consent 模板通道（best-effort，模板加「拍板」类）。
- 徽章点：web 侧栏「舰队」项 + 小程序会话入口（沿既有入口位）。

## 风险与对策

- **立即执行与在途回合冲突**：runTaskNow 对已排队/运行中任务是 no-op 带回当前态（引擎既有语义）——UI 把「已在跑」呈现为「送达将随本回合/下一回合」，不重试加压。
- **expire 扫描**：过期判定锚=提交时刻 + 舰队 decisionPolicy.expiryHours（建议时限不参与）；读路径惰性判定 + 每小时一次兜底扫（不引入新定时器面，复用引擎既有 interval 风格）；扫描只改 state 不发通知（徽章已不含 expired）。
- **注入段与 prompt 上限**：决策段计入刀2 的 24KB 总量上限，超限先截决策段之外的内容（决策是主人意志，优先保真）。

## 测试策略

- 模块级：状态机全转移与非法转移拒绝、首裁定局并发、防洪三限、过期惰性+兜底、delivered 幂等挂账、注入分段与 5 条上限滚动。
- 活体级：真岗位 escalate → 队列徽章出现 → 批准 → 立即执行回合 prompt 含裁定 → delivered；驳回路径同型；岗位删除→补岗→送达恢复。
- 回归：无拍板舰队的注入快照与刀2 完全一致（决策段零出现）。
