# Proposal — fix-tool-result-cost

## Why

P0′-1 的取证把体积按工具名归了账（单 cell，45.7MB / 5728 条）：

| 工具 | 量 | 归属 |
|---|---|---|
| `mcp__fd-memory__memory_handoff_list` | 10.6MB | 自家（上一条已修） |
| `read` / `bash` / `grep` | 17.3MB | dsh 内建（平台无旋钮，已确认） |
| `mcp__fleet-architect__fleet_turns_read` | 2.3MB | 自家 |
| `mcp__fd-memory__memory_overview` | 2.2MB | 自家 |
| `mcp__fleet-architect__fleet_list` | 1.7MB | 自家 |
| `mcp__cron__cron_list` | 1.3MB | 自家 |

这两条是自家工具里形态最明确的：

- **`fleet_turns_read`** 是架构师的诊断视图，却把最多 100 条**全字段**用
  `JSON.stringify(..., null, 2)` **美化缩进**输出——缩进本身近乎翻倍，而诊断只需要十来个字段。
- **`memory_overview`** 的截断判据是 `truncated: partitions.length >= 50`：**只看分区数**。
  一个 person 根 40 个分区、每分区 10 条标题时，它自称「未截断」却把几 MB 全发出去——
  又一次「页冒充全量」。

## What Changes

- `fleet_turns_read`：投影为诊断字段（id/岗位/source/status/errorKind/错误首段 240 字/模型/时间/用量/链位），
  紧凑 JSON，默认 20 条（上限 100），回带 `count`/`page`/`truncated`。页视图抽到
  `server/fleet-turns-view.js` 以便测试（MCP 模块 import 即起服务，测不到）。
- `memory_overview`：**两个维度同时设上限**——分区 25 个、每分区标题 3 条；
  `truncated` 如实反映任一维度被裁剪（分区有 9 页只列 3 条 → 就是截断），并回带 `total_partitions`。

## Impact

- Affected specs: `agent-fleet-architect`（回合读面分页）、`agent-memory-foundation`（overview 双维度上限）
- Affected code: `server/fleet-turns-view.js`（新增）、`server/fleet-architect-mcp.js`；
  fd-memory `src/mcp.ts`（overview 上限与 truncated 判据）
- 无迁移、无新表；语义不变——只是同一个视图少付字节，并把「这是页不是全部」说出来。
