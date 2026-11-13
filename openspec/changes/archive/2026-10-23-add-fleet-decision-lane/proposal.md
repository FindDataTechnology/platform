# Proposal: add-fleet-decision-lane（拍板通道：异步人工决策队列）

## Why

舰队成员在自治回合里遇到需要主人定向的事（预算超限、内容发布与否、方向二选一），今天只能写进日报文本等人翻——创始人视角的「等你 3 件」不存在：没有结构化待办、没有批复回流、没有超时升级。本 change 建立拍板通道：`escalate` 工具把问题连同选项落进舰队拍板队列，主人在管理面批/驳/改批，批复沿刀2 建立的注入管线自动送达原岗位下一轮（或「立即执行」手动触发），超时未批自动过期并标记。这是组织「↑汇报↓指令」两条边中缺失的指令边，与刀2 的报数边合璧后舰队才完整可运营。

## What Changes

- 新增 `escalate` 工具：舰队成员回合内可调用，提交 {question, options[], severity, deadline, recommendation} 落拍板队列（DecisionItem：open|approved|rejected|expired|delivered 状态机）。
- 拍板队列读面与操作：舰队级待办列表（含严重度/截止/来源岗位与回合）、主人批（选 option）/驳（附注）/改批（改值再批）；队列容量与每岗位每日提交上限防洪。
- 批复送达：已批/已驳项经注入管线在原岗位下一次节奏回合自动注入（「你有 1 条已批复拍板：…」）；「立即执行」按钮走引擎既有手动触发路径立即发起该岗位回合；送达完成标记 delivered。
- 超时与通知：过期未批自动置 expired（不静默消失，留在列表可重开）；队列变化经既有 unread 语义标未读 + 微信订阅信封 best-effort（复用 scheduled-task-notifications 契约）；应用入口「等你 N 件」徽章。
- 命名与边界：与萬星 mission awaiting_approval 特例**互不改动**（那是 planner 契约的一部分）；本通道是壹座舰队通用机制，未将来可作同形生产者接入。

## Capabilities

### New Capabilities

- `agent-fleet-decision-lane` — escalate 工具契约、DecisionItem 状态机与队列、批复/驳回/改批操作、批复注入送达与立即执行、超时过期、徽章与通知复用。

### Modified Capabilities

（无——注入管线与手动触发均为既有能力的新调用方；通知 unread/微信信封按 scheduled-task-notifications 既有需求复用。）

## Impact

- **代码**：fleets.db 增 `decision_items` 表；`escalate` 工具注册（模式同刀2）；注入器接拍板摘要段（刀2 已留接口）；fleets API 增拍板读写路径；FleetsPage 增拍板抽屉与徽章；应用入口徽章（web+小程序导航沿用 unread 派生）。
- **依赖**：add-fleet-core（岗位/物化任务）、add-fleet-report-lane（注入管线）；engine 手动触发（runTaskNow 既有）。
- **后续刀接口面**：驾驶舱（刀4）的「等你 N 件」红字徽章与拍板队列 UI 由本 change 提供；萬星侧 mission 审批接为同形生产者是后续独立 change。
