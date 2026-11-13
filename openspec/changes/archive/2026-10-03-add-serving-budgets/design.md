# Design: add-serving-budgets

## Context

现行超时：`agent-runner/config.js` 的 `turnTimeoutMs`（env `AGENT_RUNNER_TURN_TIMEOUT_MS`，默认 180s）传给每个 child（`child.js:33`），`turn()` 的 setTimeout 到点仅 settle(false, -32001)——child 里回合继续跑（dsh 无中断 RPC）。部署描述符（`lib/agent-serving.js composeDescriptor`）已携带 effective_rhythm 的先例：契约声明 + 部署者覆盖 + 描述符记录。ADR-0014 决策④已定：超预算=硬停（杀 child 重生），dsh 将来提供 interrupt RPC 再降级为优雅停。

## Goals / Non-Goals

**Goals**：契约/部署者两级预算声明；描述符携带有效值；runner 每 child 预算 + 硬停 + 指名上限的结构化错误 + 计量；全回合来源同纪律。

**Non-Goals**：优雅中断；硬停的平台侧通知（组合 add-agent-notifications）；门面计费变化（超时回合 outcome=error→waived 已覆盖）；预算=钱的语义（财务硬顶在 sub2api 键窗口，预算是运行时软顶）。

## Decisions

- **D1 校验**：`lib/pack-manifest.js` 增 `validateBudget(value)`——正整数、≤120（`BUDGET_MAX_MINUTES` 常量）；契约键 `serving.budget` 仅接受 `{turnMinutes}`，其余键拒绝（与 rhythm 纪律同构）。编辑器侧无新 UI 必需（契约 JSON 可达；打包编辑器预算输入随 C0 的 pack 工作顺带）。
- **D2 覆盖**：deploy 请求体 `budgets: {"<agentId>": minutes|null}`，null=清除回契约/默认；与 `rhythms` 同一验证点（`gateway/packs.js` deploy 路由）；描述符写 `effective_budget_minutes`。
- **D3 runner 执行**：spawn spec 增 `turnBudgetMs`（描述符优先，回退 config 默认）；`AgentChild` 构造收本 child 预算；超时回调从「仅 settle」改为 settle(false, -32001 带上 `${minutes}m budget` 文案) **并标记 `this.budgetKilled=true`**；manager 在 turn 异常路径检查该标记→把 child 从 children 移除并 `stop()`（复用既有 drain/evict 机制路径），下次 acquire 自然重生。HarnessClient `requestTimeoutMs = budget+30s` 随 spawn 传入。
- **D4 计量**：meter 行增 `budgetKill: true` 标记（`ok:false, error:"turn budget (Nm) exceeded"` 已天然携带，加布尔便于聚合）。
- **D5 兼容**：无 budget 的描述符零变化；全局 env 语义收窄为默认下限，文档注明。

## Risks / Open Items

- 杀 child 会终止该 agent 全部会话（含 rhythm 日会话）——预算给足（爬虫 20m）时罕见；日会话由 rollover 机制自愈（新日重建）。
- 流式（message/stream）连接在杀时由 collector `_child_exit` 路径收敛为错误帧（既有行为）。
- e2e：staging 部署 budget=1m 的测试 agent + 慢技能 → 断言结构化错误/重生/计量三件。
