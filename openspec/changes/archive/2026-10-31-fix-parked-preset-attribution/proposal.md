## Why

2026-10-31 生产实测（cheap/fd-prod，`platform` 镜像 `sha-2037686` 于 06:10Z 上线后）：
**全平台舰队报数归零**，同时**定时车道的岗位拿到的是别的岗位的工具面**。两件事同源——
`add-cell-session-persona`（park-before-first-prompt）的 park 路径**不移动 `ctx.currentPreset`**
（这是它的设计目标：「运行时默认不被定时车道移动」），而两处消费点都假设
`ctx.currentPreset` 就是当前回合的 persona。

### 证据一：报数归零（可复算）

| cell | 首个 `detail.presetPath="parked"` 事件 | 此前 6h 的 `source='self'` 报数 | 此后 `source='self'` 报数 |
|---|---|---|---|
| `1da519d4c1c0bf89`（admin） | 2026-10-31T06:11:06Z | 28 | **0** |
| `3fdc7b8e8ac03b68`（fleet） | 2026-10-31T06:18:21Z | 12 | **0** |

受影响面是**全部 persona 型舰队**（工厂集群/官网内容/公司式集群/工单分诊/本体建设…），
不是单体缺陷。归因机制：`server/routes/fleets.js` 的
`resolveAttribution({currentPreset: ctx?.currentPreset})` → `ctx.currentPreset` 停在 cell 的
部署默认 preset（admin cell = `fleet-architect`）→ 与岗位的 `targetId` 不符 → `kind:"none"`
→ 409「this agent is not a member of any fleet」。真机原话（本体建设舰队盘账岗回合）：
「报数通道返回身份不一致（not a member of any fleet）」。

### 证据二：工具面错位（同源第二面）

本体建设舰队盘账岗（`ob-scout`）的会话里出现的是 `mcp__fleet-architect__fleet_spec_read`
（= 部署默认 persona 的面），且 `wire_datasets_list` 在 `tool_search` 里 **0 命中**——
它如实报了「零画像/读不到」。**报数是诚实的，但归因与工具面都不对**。

根因在 patch 组合层：`writeMcpPatch({agentPreset: ctx.currentPreset})` 在 boot 时按**部署默认
preset**组合出一份 MCP 面与一份 `tool-filter.json`，park 路径不再为岗位重写它。生产日志逐字：

```
[dsh-profile] focused on pack "团队架构师" persona "fleet-architect":
  keeping [connector, facet-market, wire-ops, lex-ops, actions, fleet, library, cron,
           delegation, playwright, fleet-architect],
  dropped  [ ..., wire-ops-mcp ]
[dsh-profile] wrote 12 MCP server(s): … → mcp.patch.yml
```

而 cell 的 `tool-filter.json` 内容是 `{"mcpTools": {}}`——**没有任何 per-preset 段**，
`applyMcpToolRestrict(agentCtx, presetId)` 只能退回整份（空=不窄化）或部署默认面。

### 设计文档的漏项

`archive/2026-10-31-add-cell-session-persona` 的 design 断言「`ctx.currentPreset` 其余消费点
全在聊天车道」，tasks 5.1 的 grep 复核只扫了 `server/ lib/` 顶层——而
`server/routes/fleets.js` 有 **6 处**消费点（`/report` `/dispatch` `/escalate`
`/deputy/queue` `/deputy/resolve` `/deputy/escalate-to-owner`）**全在定时车道**。

### 附带发现（不属本 change，登记挂账）

本体建设 pack 声明 `registryName: "wire-ops"`，注册表在册服务名是 **`wire-ops-mcp`**
（22 工具，pack 要的 10 个全齐）；`wire-ops` 只是 cell operator 层 `mcp.json` 里的本地别名
（同端点 31896，server 自报 `wire-ops-mcp`）。「registry 未在册」在两份清单间结论相反——
铸造/校验必须区分「注册表服务名」与「部署别名」。另：柏讯侧文档里「registry 未在册」的取证
查的是 `GET /api/servers`（MCP 服务注册表），不是 pack 市场货架。

## What Changes

- **归因改读在飞回合（核心）**：报数/派发/升级/副驾四路的归属解析，优先用**运行账本的
  在飞回合**（`ctx.fleetTurnLedger.openTurns()` 带 `fleetId`/`memberId`），其次用**运行中
  任务的 `sourceTag`**（cron 物化的舰队回合），最后才退回「回合自身 preset」的 persona 扫描。
  **不采信调用方给的任何岗位标识**（D3 的服务端归因纪律不变）。
- **会话级 persona 面**：cell 侧写 `tool-filter.json` 时补 `byPreset` 段——每个已装 pack 的
  persona 一节（该 persona 自己的 allowlist），使 `applyMcpToolRestrict(agentCtx, presetId)`
  能按 parked preset 取到自己的面，而不是退回部署默认面。runner 侧
  `agent-runner/compose.js` 已是同款先例，reader 不变。
- **可观测**：报数归属结果落事实列 `member_turn_events.detail.attribution`
  （`{source, fleetId, memberId}`，`source ∈ {turn, job-sourceTag, cluster-task, preset, none}`），
  使「岗位报数被拒」日后可从台账直接判读。

## Capabilities

### Modified Capabilities

- `agent-fleet-report-lane`：「报数归属按岗位解析且 a2a 岗位诚实降级」→ 归因优先级改为
  在飞回合/运行中任务优先，并新增 parked 场景 + 归属事实列。
- `cron-module`：「定时回合的 persona 组合按会话驻留且不动运行时默认」→ 补两条约束：
  驻留 SHALL NOT 使该回合的报数/派发/升级归属失配；驻留会话 SHALL 持有自己 preset 的工具面。

## Impact

- `server/fleet-reports.js`：`resolveAttribution` 新增 `openTurns` 分支（在飞回合优先）+
  运行中任务分支放宽到 persona 任务。
- `server/routes/fleets.js`：六处归因调用点补传 `openTurns()`；报数受理处落归属事实。
- `server.js`：`recordFleetAttribution` / `takeFleetAttribution` 一次性事实桥 +
  回合收尾合入 `detail.attribution`。
- `dsh-profile.js`：cell 侧 `writeToolFilterPatch` 补 `byPreset` 段（`packPersonaToolFaces`）。
- tests：`scripts/test-fleet-report-lane.mjs` 补 parked 归因三例；
  `scripts/test-full-mode-tool-scope-integration.mjs` 补 per-preset 面四例。
- rollback：`FLEET_PARKED_ATTRIBUTION=off` 回到旧行为（只读 `ctx.currentPreset`）；
  `FLEET_PARKED_TOOL_FACE=off` 回到整份部署默认面。
