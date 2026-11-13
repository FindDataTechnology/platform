## Why

底稿 `docs/agent-parallel-execution-explore.md` 切片④：记忆轴与计量轴目前是两条不互查的平行线——
永忆 `f/` 里的回合事实页不知道那笔 token 是谁花的钱买的（无 turn_id/成本锚），记账日行也不知道
当时发生了什么。四补丁把两轴用同一身份锚缝起来，并让记账反哺记忆（成本周报进 `f/` 作蒸馏输入）。

## What Changes

- **补丁1 · 事实页锚**：回合事实写永忆时页面头部带锚行——`turn_id / run_id / carrier / model /
  tokens（含计费输入三列和）/ status`；台账 `trace_turn_id` 反向链不变。「每页记忆都知道自己
  是谁花的钱买的」；捕获缝扩展携带 meta（ledgerTurn/model），fire-and-forget 与降级开纪律不变。
- **补丁2 · 事实/观测分流（钉住既有行为）**：五类事实恒落 `f/<fleetId>`（跨承载合并），L0 高频
  观测恒落各承载 `d/<…>`——本片以 spec 钉住，不新增写路径。
- **补丁3 · 换防交接锚**：swap 事实**先于**清史落页（交接后清），内容升级为离任锚——末次回合
  （turnId/status/model/carrier）+ 新在岗者 + 是否清史；「身体换了，记忆跟着走」。
- **补丁4 · 成本周报反哺蒸馏**：`server/fleet-cost-digest.js`——每舰队按周汇总日行（turns/ok/
  failed/估算成本/queue_wait），周环比 movers（成本×2 或等待+50%）如实点名，一页
  「舰队成本周报」进 `f/`（kind=cost-weekly）；6h 步进检查周更，降级开（记忆缺席零影响），
  作为 L2 蒸馏的新 L1 源。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-fleet-core`：
  - **MODIFIED**「岗位记忆独立于对话史存在」——补锚行语义、事实/观测分流、换防交接锚（事实
    先于清史）；
  - **ADDED**「舰队成本周报反哺记忆」——周汇总页的生成、movers 口径与降级开。

## Impact

- **代码**：`server.js`（captureFleetTurnFact 收 meta + 锚行；周报定时器）；`server/routes/fleets.js`
  （swap 重排 + 离任锚）；`server/fleet-cost-digest.js`（新模块）。
- **契约**：五类事实 kind 不变，新增 kind=cost-weekly；记忆页格式变化对蒸馏器透明（纯文本页）。
- **测试**：锚行格式、swap 先于清史、周报聚合与 movers 算式、降级开。
- **风险**：swap 重排改变「清史后仍写事实」的现状顺序——事实本走外部服务（fd-memory），与镜像
  会话清空无耦合；重排只是让锚里能读到清史前的末次回合。
