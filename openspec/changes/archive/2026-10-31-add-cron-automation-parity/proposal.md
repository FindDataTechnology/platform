# Proposal: add-cron-automation-parity

## Why

定时任务的调度模型停留在"cron 表达式 + 绝对时刻 once"：说不清"每 40 天跑一次"（cron 字段表达不了步进超上限）、没法一句话约"8 分钟后"（agent 与表单都只能算死一个 ISO 绝对时刻——客户端自算时刻一旦落在过去会静默滚到明年，ZCode 用 relative delayMinutes 专治此坑）、任务要么无限重复要么一次性（没有"跑满 N 次自动收口"）、建完改不了（cron-mcp 只有 create/list/pause/delete，调提示词只能删了重建并丢执行史）、执行史只在 UI 露最近一条（`history.at(-1)`，missed/耗时/花销都埋着）。本 change 对齐 ZCode 自动化模型的四件调度形态 + 一次 update 通道 + 执行史面。

## What Changes

- **相对一次性**：create 接受"延后时长"（分钟级正整数），**接受时刻由服务端真实时钟锚定**为绝对 when（客户端不得自算），拒绝已过期语义；UI 提供「N 分钟后 / N 小时后」快捷输入并预览落点时刻。
- **every-N 间隔**：recurring 新增 schedule kind = interval（数值 1–200 × 单位 minute/hour/day/week/month/year）；存储以规则为真值，相位可钉时分；cron 表达得出的（如 */20 分钟）照旧可用 cron 形态，表达不出的走 interval；人读文案由规则渲染（locale 化）。
- **有限次数**：recurring/interval 任务可带 maxRuns；跑满自动 completed（沿用既有 status），列表显示"已跑 x/N"。
- **update 通道**：cron-mcp 增 `cron_update`（改 name/prompt/schedule/maxRuns，id、执行史、暂停态保留；改 schedule 重算 next-run），WS 面同步管理消息；表单支持对既有任务重开编辑。
- **执行史面**：任务行可展开历次执行（时刻/结局/耗时/tokens/missed 补跑标记），数据取自既有 history 条目，不新增后端枚举。

**非目标**：不动 task-engine 执行语义与补跑（downtime catchup 在产）；不动智语/万星侧调度入口；不引入日历选择器；不动"停机静默丢单终结"条款。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `cron-module`: 「Job scheduling API」扩三种 schedule 形态（相对一次性、interval、maxRuns）并把 update 纳入管理操作面。
- `agent-scheduling-tools`: create 参数面接受相对时长/interval/maxRuns 且钉死"服务端锚时"纪律；「List, pause, and delete through tools」升级为含 update 的管理面。
- `scheduled-tasks-ui`: 创建表单增相对/interval/maxRuns 控件；任务行增编辑动作与执行史展开。

## Impact

- 服务端：调度器（interval 规则计算 next-run、maxRuns 计数收口）、`cron_*` WS 消息面、`server/cron-mcp.js`（新 update 工具 + create 参数扩展）。
- 存储：jobs.json 记录加 schedule kind 字段（interval/maxRuns/runs 计数），旧记录零迁移（缺字段=cron/once 现语义）。
- Web：`TasksPage.tsx`（表单三控件、编辑弹窗、history 展开）、`lib/cron-text.ts`（interval 人读文案五语言）。
- 不动：dsh 车道、执行引擎、补跑逻辑、通知/未读面。
