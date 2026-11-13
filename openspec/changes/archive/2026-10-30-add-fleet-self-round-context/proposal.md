## Why

舰队岗位的每轮开火都是**全新会话**（`server/cron-runner.js:360-372` 明确设计为逐轮轮换 child session id，`fix-fleet-round-discipline` D4/D7），而平台注入的巡视上下文**只含直接下级的最新报数**（`server/fleet-context.js:99-115`）——岗位看不到自己上一轮说过什么、做了什么。CEO 岗因此把每轮产出写进工作区文件当作跨轮记忆（`ceo-patrol-round4.md`，40+ 轮、56KB），下一轮光读它就把 10 分钟回合预算吃光：约每 6 轮就有 1 轮以 `turn_budget_exceeded` 零产出收场（2026-10-29 真机诊断 §15.88）。现有处置是 `PATROL_DISCIPLINE` 提示词劝阻，属**劝告而非保障**——那个 56KB 文件还在原地，岗位随时可以再翻。

## What Changes

- **岗位巡视上下文新增「本岗位最近几轮」段**：在 `{{fleetContext}}` 渲染时注入该岗位**自己**最近 N 轮的报数摘要（槽值/阻塞/摘要/时间），与既有下级报数段并列。数据源是 `member_reports`（`server/routes/fleets-db.js:55-65`，append-only，已有 `listReports(memberId)`），不新增存储。
- **该段对无下级岗位同样生效**：当前 `children.length === 0` 时只输出「（本岗位无直接下级）」（`server/fleet-context.js:99-101`），叶子岗位上下文实际为空；新增段让叶子岗位也能拿到自身连续视图。
- **新增「近期执行健康」信号**：注入该岗位最近 N 轮的执行结局（成败/超时/错误类别），取自 `member_turn_events`（`server/routes/fleets-db.js:293-307`）。缺此信号时，超时轮在 `member_reports` 里**零留痕**，岗位无从知道「我上一轮其实是被杀掉的」。
- **段内容按数据呈现，明确标注不可当指令执行**：报数摘要可能引用外部文本（下级报数、工单原话），注入时必须声明为数据，避免把上游内容带成下一轮的命令。
- **总预算与既有守护线对齐**：新增段受 `fleetContext` 既有总量上限约束，超限按标记截断，不得挤掉下级报数段。
- **撤回性**：`PATROL_DISCIPLINE` 中「不要再去工作区找更全的报数」一条**保留**，但定位从「唯一防线」降为「补充说明」——平台既然给了，就应同时告诉它给了什么。

**非目标（BREAKING 无）**：不改 dsh、不改模型层、不引入跨轮会话记忆（逐轮轮换 session 的设计保留）、不改报数工具契约、不改任何岗位提示词模板。

## Capabilities

### New Capabilities

（无——本变更修改既有巡视上下文注入的行为，不引入新能力面。）

### Modified Capabilities

- `agent-fleet-report-lane`: 「巡视上下文注入」requirement 的注入内容从「下级报数摘要 + 舰队在岗概况」扩展为**同时包含本岗位自身最近轮次视图与近期执行健康**；并新增「无下级岗位同样获得自身视图」与「注入内容声明为数据而非指令」两条约束。

## Impact

- **代码**：`server/fleet-context.js`（渲染主体，新增两段 + 预算分配）、`server/routes/fleets-db.js`（只读复用 `listReports`；`member_turn_events` 现有查询若无按岗位取最近 N 轮的方法则补一个只读查询）。
- **数据**：零迁移。`member_reports` / `member_turn_events` 均为既有表，本变更只读。
- **API/契约**：不改任何对外路由形状；`{{fleetContext}}` 占位符契约不变（仍是单个字符串段）。
- **舰队运行时**：所有现役舰队岗位**下次开火即生效**（平台侧注入，不改存量岗位提示词）。上下文体积增加，需与既有 `TOTAL_LIMIT`（24KB）一并核算。
- **观测**：需要能对比「注入前后 CEO 岗 `turn_budget_exceeded` 发生率」——`member_turn_events.error_kind` 已具备该口径，无需新增埋点。
- **风险**：注入自身历史可能强化岗位的既有行为模式（自我强化）。以「数据非指令」标注 + 只注入摘要（非全文）+ 有限轮数为约束；验收时需检查岗位是否出现「跳过实际巡视、只复述上轮」的退化。
