# Proposal: add-tool-posts

## Why

成员三层的缺层(explore 底稿 §四 T1):50+ 混合舰队的经济学要求数十岗「零 token 确定性执行」——抓取/转格式/入库/校对这类岗不需要 persona 与 LLM。编导代数第一波(`add-fleet-orchestration`)已就位,dispatch/handoff 都指向「会思考的岗」;本 change 补上第四种目标类型 **工具岗(targetKind: tool)**:一次 MCP 工具调用即一回合,复用 `lib/action-executor.js` 的客户端传输(连接→callTool→关闭,错误分类),零 LLM、零 token、确定性出 JSON。

## What Changes

- **targetKind `tool`**:member.targetId = `server::tool`(注册 MCP 服上的工具名);节奏回合的 promptTemplate = **JSON 参数串**(确定性,非自然语言)。写面校验:server 可路由(注册表条目存在)、tool 非空、promptTemplate 为合法 JSON(有节奏时);工具岗**允许多岗**(无状态,同 a2a 规则),不参与唯一岗扫描。
- **执行器 `runToolTurn`**:`runCronJobTurn` 新分支——解析 JSON 参数 → `resolveServerEndpoint` 路由 → MCP callTool → 结果 JSON 落会话 + 返回 `{ok, text}`;O1 事件自动产(收口既有),model=null 如实。非法 JSON 参数、不可路由 server、工具报错均为结构化失败(errorKind 归类:runtime_not_ready/other)。
- **派发与接棒可达**:manual 任务(delegation/handoff/execute-now 车道)支持 tool 目标(`createManualTask` 增 tool 参数,targetType="tool");dispatch 桥与 handoff 触发器对工具岗放行(替代现行 cluster 拒绝位);护栏不变(同舰/频次/链深)。
- **成本预估如实**:工具岗 turns/day 计入、tokens 计 0(`estimateFleetCost` 分流)。
- **驾驶舱/架构师**:派生态徽章与 latest 视图照常(在场判定走既有 target 解析:注册表条目在即 alive);架构师 draft 校验新增 tool 目标解析(v1 架构师尚不能编边,如实记)。

## Capabilities

### New Capabilities

(无——挂在既有能力面)

### Modified Capabilities

- `agent-fleet-core`: MODIFIED——targetRef 支持第四种目标 tool(server::tool,多岗允许,唯一岗扫描豁免),物化为 targetType=tool 的任务,节奏 prompt 为 JSON 参数;ADDED——工具岗回合执行器(确定性调用、结果落会话、失败如实)。

(编排侧 dispatch/handoff 目标域扩至工具岗的修订,折进**在途未归档**的 `add-fleet-orchestration` change 一并出片——避免姊妹 change 对同一需求双 MODIFIED 的归档死锁;两 change 同列车。)

## Impact

- **代码**:`server/cron-runner.js`(runToolTurn 分支)、`task-engine.js`(createManualTask tool 参数)、`server/routes/fleets.js`(写面校验 + resolveTarget tool 分支 + dispatch 桥放行)、`server/fleet-architect.js`(draft/estimate 分流)、`server/fleet-orchestration.js`(handoff 目标域)、`server/fleet-reconcile.js`(materializedSpec targetType 映射,如需)。
- **测试**:新增 `scripts/test-tool-posts.mjs`(参数校验/执行器注入 fake MCP/失败分类/多岗豁免/dispatch+handoff 可达/预估 0 token);十二套回归零新增红。
- **兼容性**:既有三种 targetKind 逐字节不变;非舰队任务零扰动;出片随攒车列车。
- **非目标**:不做 pack skills(SKILL.md)执行;不做动作闸高危操作(带确认闸的动作不进舰队);不做工具结果的后处理 LLM 格式化;不建新 MCP 服。
