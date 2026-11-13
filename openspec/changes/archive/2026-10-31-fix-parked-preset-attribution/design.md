# Design: fix-parked-preset-attribution

> 底稿：2026-10-31 生产实测（见 proposal 证据一/二）。本 design 只定**归因的权威信号**
> 与**驻留会话的工具面组合**，不动 park 路径本身的设计目标（「运行时默认不被定时车道移动」
> 保持成立）。

## Context

三条已核实的现状事实：

1. **park 路径不移动 `ctx.currentPreset`**（`server/cron-runner.js` park 分支只调
   `bridge.setPreset({sessionId, presetId})`；legacy 分支才走 `switchPresetForJob` →
   `ctx.switchPresetTo` → `ctx.currentPreset = id`）。这是 `add-cell-session-persona` 的
   既定目标，不是缺陷。
2. **归因读 `ctx.currentPreset`**：`server/routes/fleets.js` 六处
   （`/report`、`/dispatch`、`/escalate`、`/deputy/queue`、`/deputy/resolve`、
   `/deputy/escalate-to-owner`）→ `resolveAttribution`。该函数原有两条分支：`cluster-task`
   （读运行中任务的 `sourceTag`）与 `preset`（读 `currentPreset` 匹配 persona 岗位）。
3. **MCP 面是 cell 级单份，按部署默认 preset 组合**：`writeMcpPatch({agentPreset:
   ctx.currentPreset})` 在 boot 时写一份 `mcp.patch.yml` + 一份 `tool-filter.json`；
   cell 侧的 `tool-filter.json` 只有整份 `mcpTools`（`byPreset` 段是 runner 侧
   `agent-runner/compose.js` 独有的先例）。

由此产生两个失效面：**归因落到 `kind:"none"`**（409）与**岗位拿到别人的工具面**。

## Goals / Non-Goals

- **Goal**：驻留（parked）回合的报数/派发/升级/副驾归属正确；驻留会话持有自己 preset
  的 MCP 工具面；两者都不采信调用方输入。
- **Non-Goal**：不动 park 路径本身（不重引入重启、不移动 `ctx.currentPreset`）；
  不改 chat 车道的 preset 选择语义；不改「a2a 岗位诚实降级为执行摘要」；
  不改「同一 persona 在多个岗位 ⇒ ambiguous 拒收」这条既有纪律；
  不改 `mcp.patch.yml` 的 server 集合（见 Open Questions）。

## Decisions

### D1 归因的权威信号 = 在飞回合 → 运行中任务 → 回合自身 preset

**取舍**：三个候选信号——

| 候选 | 判定 |
|---|---|
| `ctx.currentPreset` | **否决**：park 路径按设计不动它，永远是部署默认。 |
| 调用方传岗位 id | **否决**：违反 D3（服务端归因，调用方不得代报任意岗位）。 |
| 在飞回合（`fleetTurnLedger.openTurns()`）/ 运行中任务 `sourceTag` | **采纳**：两者都是服务端自己的账——`begin(job)` 已用 `resolveTurnPost`（sourceTag → origin.fleet → persona 扫描）解析出岗位；`sourceTag` 由 `fleet-reconcile` 物化时写入。调用方无法伪造。 |

**优先级**：在飞回合（唯一命中才采纳）→ 运行中任务 `sourceTag`（唯一命中才采纳）→
回合自身 preset 的 persona 扫描。多命中一律**不猜**：退回下一级，最终 `none`/`ambiguous`
诚实拒收（既有纪律不变）。

**为什么在飞回合优先于运行中任务**：handoff/dispatch 型手动任务的 `origin.fleet` 是**内部
字段**，`clientShape`（`cron.listJobs()` 的 wire 形状）按设计剥掉了它——所以「运行中任务」
只能覆盖 cron 物化的回合；在飞回合覆盖全部形态（含 handoff 链）。两者叠加是纵深，不是冗余。

### D2 驻留会话的工具面 = per-preset 段（byPreset）

**问题**：`mcp.patch.yml` 是 cell 级单份，写在 boot 时按 `ctx.currentPreset` 组合；
`tool-filter.json` 的 cell 侧也只有整份 `mcpTools`，`applyMcpToolRestrict(agentCtx, presetId)`
取不到 `byPreset[presetId]` 段就退回整份面。

**采纳方案**：cell 侧写 `tool-filter.json` 时**补 `byPreset` 段**——每个已装 pack 的
persona 一节，内容 = `effectiveMcpTools(manifest, agent)` 的既有派生（该 persona 自己的
allowlist，未声明时按既有语义回落到 pack 级 allowTools）。这与 runner 侧
`agent-runner/compose.js` 的做法逐字同源（那里已同时写整份 union 与 `byPreset`），
reader（`readMcpToolFilterFor`）无需改动。

**为什么不是「每回合重写 patch」**：patch 变更需要 child 重载，等于把 park 的零重启优势
退回重启，与目标相反。per-preset 段**一次 boot 写全**，parked 会话在
`applyMcpToolRestrict(agentCtx, parkedPreset)` 时按 preset id 取自己那节。

**形状纪律**：`byPreset` 非空时才用 `{ mcpTools, byPreset }` 包装形状；为空时保持
**裸 map** 逐字节不变——reader 靠「own `byPreset` 键」区分两者，裸 map 绝不能意外获得该键
（真机自测逮住：包装空 section 会写出 `{"mcpTools": {"mcpTools": null}}`）。

**边界**：per-preset 段只管**工具面**（allowlist）。server 本身在 `mcp.patch.yml` 里——
cell 级 patch 按部署默认组合时被丢掉的 server（如 `wire-ops-mcp`）对任何 persona 都不在。
这条**不属本 change**（见 Open Questions 与 tasks 6.1）。

### D3 归因事实列（可观测）

`member_turn_events.detail` 增 `attribution: {source, fleetId, memberId}`：
`source ∈ {turn, job-sourceTag, cluster-task, preset, none}`。写入走**一次性事实桥**
（`ctx.recordFleetAttribution` / `takeFleetAttribution`，与既有 `takeFleetModelNotices`
同款纪律）：报数受理时按 `memberId` stash，回合收尾时合入 `detail`。理由：报数发生在回合
**中途**，而事件行在回合**末尾**写——跨这两段只能靠进程内一次性 stash（turn 在共享 runtime
上串行 ⇒ 每岗一条即回合准确）。**这是观测来源、不可推断**。

### D4 回归必须可复算

修复验收的**唯一硬判据**是复算 proposal 证据一的指标：**首个 parked 事件之后
`member_reports`（`source='self'`）不得归零**。工具面另用「岗位声明的 server/工具在该岗位
会话里可 `tool_search` 命中」单独判定（工具面缺失的岗位会零产出但报数在，两者不能混判）。

## Risks / Trade-offs

- **在飞回合可能把报数记到别的岗位**：`openTurns()` 的唯一性收敛（>1 条即不采纳）挡住了
  并发链；退到 `sourceTag` 时同样要求唯一。最坏结局是 `none`（诚实拒收），不是错记。
- **`openTurns` 与 report 的进程边界**：fleet MCP 子进程经 loopback（`bridgeOrigin()` =
  cell 自身 `HOST:PORT`，`FLEET_MCP_URL` 未设）打回同进程，ledger 在内存里可见——链路成立；
  若将来改用外置 MCP 桥，此分支退化为空（自动落回 `sourceTag` 分支，不报错）。
- **per-preset 段使 cell 侧 tool-filter 变大**：量级 = 已装 persona 数 × allowlist 大小；
  与 runner 侧同量级，可接受。
- **chat 车道零影响**：chat 车道传的也是真实 preset id，补段后它取到**更准**的面
  （此前退回整份部署默认面），不会变窄到丢失既有能力；既有用例已证。

## Migration Plan

1. 归因：`resolveAttribution` 加 `openTurns` 分支 + 运行中任务分支放宽 → 单测钉住
   「parked 命中」「多回合不猜」「chat 车道不变」。
2. 事实列：`recordFleetAttribution` / `takeFleetAttribution` + 收尾合入 detail。
3. 工具面：cell 侧 `packPersonaToolFaces` → `writeToolFilterPatch` 补 `byPreset` →
   单测断言「某 persona 的段只含自己的 server」。
4. 出片后复算「parked 后 self 报数归零」指标 + 本体建设舰队首轮重跑。

## Open Questions

- **server 级集合差异**（`mcp.patch.yml` 里被部署默认 persona 丢掉的 server，如
  `wire-ops-mcp`）：per-preset 段只管 allowlist，管不到「server 根本没进 patch」。
  本体建设 pack 声明的是 `wire-ops`（cell 部署别名，**在** patch 里），故其第一轮不受此限；
  但若改用注册表名 `wire-ops-mcp`，就必须解决 server 级供给——独立立项（挂账给柏讯侧
  需求书 B 段）。
- **`registryName` 语义分叉**：「注册表服务名」vs「部署别名」两条清单须在 pack 校验层
  分开校验（当前 `lib/pack-manifest.js` 只校 `registryName` 的字符形状，不校存在性）——
  挂账，本 change 不动。
