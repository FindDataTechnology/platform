# Proposal — fix-fleet-roster-cost

## Why

按调用次数与单次体积分开量（单 cell，同一份 trace）：

| 工具 | 调用 | 总量 | 平均/次 |
|---|---|---|---|
| `memory_handoff_list` | 102 | 10.8MB | 106KB |
| `fleet_turns_read` | 49 | 2.3MB | 47KB |
| `fleet_list` | 53 | 1.7MB | **31.5KB** |
| `cron_list` | 12 | 1.3MB | **112KB** |

`fleet_list` 的路由每行只回 6 个短字段——**31.5KB 不是内容多，是 `JSON.stringify(…, null, 2)` 把每个扁平对象摊成约 9 行缩进**。
一个 cell 最多 57 支舰队（实测：14 个 cell 共 81 支，单 cell 最多 57），紧凑输出约 7KB。

## What Changes

- `fleet_list` 改为紧凑 JSON + 六字段投影（id/name/state/memberCount/openDecisions/failing）：
  **名册默认完整下发**——架构建模时漏一支舰队等于谎报「不存在」——体积从缩进来，不从内容来。
- 病态规模硬上限 200 行；超限回带 `total` 并置 `truncated`（不静默截断）。
- 视图与 `fleet_turns_read` 同住 `server/fleet-turns-view.js`（纯函数、可测；MCP 子进程无法被 import）。

## Impact

- Affected specs: `agent-fleet-architect`（工具面：名册完整且轻 + 2 场景）
- Affected code: `server/fleet-turns-view.js`（`shapeFleetRoster`）、`server/fleet-architect-mcp.js`
- 无迁移、无新表、无语义变化：同一份名册，少付缩进。
