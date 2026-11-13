# Proposal: add-agent-config-dims

## Why

agent/bot 的可配置维度只有「模型」(五层解析链)与「prompt/preset」;思考深度是**每 provider 一个全局值**(`llm.effort.<provider>`),同 provider 下所有 agent 共用一个,「每个岗位自己的思考深度」做不到;最大上下文只有模型家族的只读硬编码,客户无法按 agent 收紧。配置维度不全,后面的模板/案例/方法论沉淀就没有字段可存。

## What Changes

- **思考深度两层**:agent(岗位/bot/agent 覆盖层)可声明默认 effort;回合执行时按该默认值经 `dshBridge.setModel({ effort })` **live 切换**(不重启子进程);声明非法/模型不支持时回落 provider 全局值并留 notice,不失败。
- **上下文使用上限**:agent 可声明 `contextBudget`(正整数 token);回合执行时作为该 agent 的用量上限,超出如实失败并归类 `context_budget`,不静默截断对话。
- 两维均进既有五层解析链同样的**声明-覆盖**语义:agent 声明 > 舰队默认 > cell 默认;缺声明零变化(逐字节等价现状)。
- 检查器配置页签暴露两维(模型旁),改动走既有岗位/bot 写路径;bot 侧同样可选。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-core`: 岗位配置维度扩展——岗位可声明思考深度与上下文使用上限,进模型解析链同语义的覆盖链,回合执行按其生效。
- `bot-relay`: bot 可声明思考深度与上下文使用上限,回合执行按其生效;缺声明零变化。

## Impact

- 后端:`fleets-db.js`(fleet_members 增两列,迁移)、`db.js`(bots 增两列)、`fleet-model.js`(解析链扩两维)、`cron-runner.js`(回合开始按生效值 setModel + 预算检查)、`routes/fleets.js`(写面校验)、`server/bots.js`(bot 回合读取)。
- 前端:`InspectorDrawer.tsx`(两维输入)、`BotsPage.tsx`(同)、i18n 五语言。
- **不写 dsh profile**:dsh 的 effort 是 per-provider 的(`dsh-profile.js:232` 注释事实),按 agent 写 profile 会互相覆盖;故 agent 级 effort 只作为声明存放,生效靠回合级 live setModel。
- 非目标:不改 `contextWindow` 模型真相(只做使用上限);不做 per-agent 的 provider 级路由隔离;不做 context 自动摘要。
