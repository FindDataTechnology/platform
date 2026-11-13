# Tasks: add-fleet-decision-lane

## 1. 存储与工具

- [x] 1.1 fleets.db 增 decision_items 表 + 状态机转移校验（open→approved/rejected/expired、expired→open 重开、approved/rejected→delivered），验证全合法转移与非法转移拒绝的单测
- [x] 1.2 escalate 工具注册：question/options 2..6/severity 校验、suggestedDeadline 仅展示不参与过期、归属解析复用刀2 链、每岗每日 ≤10 与 open 队列 ≤50 防洪，验证非成员拒绝/超限拒绝/返回队列位与余量的单测
- [x] 1.3 乐观并发裁定：UPDATE…WHERE state='open' 首裁定局，验证并发双批仅首裁生效

## 2. 送达流水

- [x] 2.1 注入器决策段：approved/rejected 待送达项渲染独立分段（问题+裁定+注），单轮 ≤5 条滚动、无拍板零空段，验证分段注入与刀2 注入快照回归（无拍板时逐字节一致）
- [x] 2.2 delivered 挂账：回合完成回调按 memberId+itemId 幂等标记，验证下一节奏送达与重复完成不重复挂账
- [x] 2.3 立即执行：execute-now 走 runTaskNow，已在跑时呈现随本轮/下轮语义不重试，验证立即回合 prompt 含裁定
- [x] 2.4 送达悬挂：岗位删除后批复停 approved 标「待岗位恢复」，补岗后首次节奏完成送达，验证删除→补岗全链单测

## 3. 读面、通知与前端

- [x] 3.1 拍板 API：列表（state 过滤+来源链接）、approve/reject/amend/reopen/execute-now 五操作 + 主人归属校验，验证越权 403、过期项不可批仅可重开、amend 不可改写问题文本
- [x] 3.2 过期机制：锚=提交时刻+舰队 decisionPolicy.expiryHours（默认 72，0=关；建议时限不参与），读路径惰性判定 + 每小时兜底扫，验证策略届满转 expired 留列表、建议时限不触发过期、徽章不计入
- [x] 3.3 徽章与通知：unread 派生（open 数×查看时间）+ web 侧栏/小程序入口「等你 N 件」徽章 + 微信信封 best-effort 接线，验证徽章只计 open
- [x] 3.4 FleetsPage 拍板抽屉：待办列表（严重度/截止/来源跳转）+ 批/驳/改批/重开/立即执行操作态，stub 断言列表与操作后状态转移呈现

## 4. 活体验收

- [x] 4.1 生产走查（2026-10-23 双腿闭环：批准→execute-now 回合 prompt 逐字含裁定+批注→delivered；驳回→附注→下一自然节奏火送达 prompt 逐字含「裁定：驳回。理由：维持原计划，周五发布」→delivered；均 by=aloadtree 真回合触发）：真岗位 escalate → 徽章「等你 1 件」→ 批准 → 立即执行回合 prompt 含裁定（真会话取证）→ delivered；驳回+附注路径同型走通
- [ ] 4.2 回归：无拍板舰队注入快照与刀2 一致 + 既有通知/scheduling-tools 测试全绿
