# Proposal: add-serving-budgets

## Why

回合超时今天是 runner 级全局 180 秒（`AGENT_RUNNER_TURN_TIMEOUT_MS`），对所有 agent 一刀切；且超时的现行语义只是「放弃等待」——调用方拿到错误，child 里回合照跑、部署键照烧（dsh 无中断 RPC，`server/agent-session.js:97`）。真实工作负载（爬虫自愈：clone→修复→验证链→开 PR）需要每 agent 十分钟级的预算，超预算必须有**定义良好的终态**而不是静默烧钱。这是萬星程序（ADR-0014 决策④）与爬虫 pack（C0）的共同前置。

## What Changes

- 服务契约可选声明 **`serving.budget.turnMinutes`**（作者默认；校验：正整数，默认上限 120 分钟）。
- 部署请求可携带 **budget 覆盖**（与 rhythm 覆盖同形：`budgets: { "<agentId>": minutes | null }`）；有效预算 = 部署者覆盖 → 契约声明 → runner 全局默认。
- 部署描述符携带**有效预算**（与 effective rhythm 同位；纯数值，不涉密钥/端点/模型）。
- runner 按 **每 agent 有效预算**执行所有回合来源（message/self/digest 同一预算）；超限 → **硬停**（ADR-0014 ④：杀 child，下次触达重生；文件态不受损），调用方收到**指名预算上限的结构化错误**，计量行记录 budget kill。

**非目标**：优雅中断（等 dsh 上游提供 interrupt RPC 后降级，本变更不视为终态）；硬停时的平台侧通知（属 add-agent-notifications 能力域，之后组合）；门面对外部回合的计费语义不变（超时回合 outcome=error → waived，已有 spec 覆盖）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-authoring`: 「Agents are persona entries」——服务契约可声明 `budget.turnMinutes`（回合时长上限），校验同 rhythm 纪律（纯数值声明，拒绝夹带运行时配置）。
- `a2a-agent-serving`: 「Deploy action composes registry-native assets」——描述符字段集增「有效回合预算」；有效值=部署者覆盖优先于契约声明；响应暴露覆盖生效。
- `agent-runner`: 新增「回合预算以硬停执行」——每 agent 有效预算、全回合来源适用、超限杀 child 重生、结构化错误指名上限、计量记录。

## Impact

- **代码**：`lib/pack-manifest.js`（budget 校验）、`gateway/packs.js`（budgets 覆盖）、`lib/agent-serving.js`（描述符组装）、`agent-runner/{config,child,manager}.js`（每 child 预算 + 硬停 + 错误形状 + 计量）。
- **契约**：pack manifest 服务契约新增可选字段（向后兼容——无 budget 的契约照旧走全局默认）。
- **运维**：`AGENT_RUNNER_TURN_TIMEOUT_MS` 语义收窄为「无声明时的全局下限默认」。
