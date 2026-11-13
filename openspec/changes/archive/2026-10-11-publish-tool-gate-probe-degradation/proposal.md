# Proposal: publish-tool-gate-probe-degradation

## Why

`add-mcp-tool-scoping` 的发布门用一次活探测（initialize + tools/list）兜底 registry 快照滞后。生产实测：三条已上牌 server 的公网 MCP 端点一律 **503 `BILLING_UNAVAILABLE`**（registry 预检 fail-closed，计费面不可达），探测恒不可达 → 快照滞后的合法工具名被误拒。发布正确性不该依赖计费面的可用性，也不该依赖一个与发布者意图无关的运营状态。

## What Changes

- **探测不可达不再等同于「名字不存在」**：发布门把探测失败（含 503/超时/鉴权拒绝）判为「快照不可用/未确认」，而不是「工具不存在」。
- **新增一条明确判据**：声明的工具名不在快照中、且探测无法确认时，发布**仍拒绝**（不静默放行）——但错误信息区分「确认不存在」与「无法确认，请刷新条目快照后再发布」，给出可执行的下一步。
- **快照刷新通道**：补一条运营动作入口（脚本化 PATCH `tool_list`），让「刷新条目快照」成为文档化的修复步骤而非临时摸索；台账与 finddata 侧对账动作挂同一入口。
- 不改商业集闭合逻辑（与探测结果无关，保持不变）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-authoring`: 发布门对「快照缺失 + 探测不可达」的处置从「名字不存在→拒」改为「无法确认→拒，并给出刷新快照的可执行指引」；新增快照刷新作为一等运营动作。

## Impact

- `lib/publish-tool-gate.js`（探测失败分类、错误文案）、`gateway/packs.js`（无形状变化）
- `docs/registry-maintenance.md`（快照刷新配方登记）
- 单测：`scripts/test-publish-tool-gate.mjs` 增/改「探测不可达」用例
