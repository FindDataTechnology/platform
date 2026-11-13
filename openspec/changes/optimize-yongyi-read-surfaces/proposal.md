## Why

2026-11-08 的两处修复（`memory_handoff_list` 10.6MB、`memory_overview` 2.2MB）只是同一个病灶的头部：永忆的读面没有统一的出口纪律，谁定义工具谁决定返回形状。今天的读面仍有多处无上限的返回路径，同时一个 fleet 回合要串行调三次 `/digest`、每次都从盘上重建全部 L2 候选并全表解码向量。同理，召回融合是「向量整段在前、关键词哨兵补位」的拼接而不是融合，`search_keys` 的 ×2 加权档位从未生效，评测闸门与 spec 口径漂移且基线不可复现——继续按单点修，下一次事故只会换一个工具名。

## What Changes

- **读面上限统一**：`memory_query` / `memory_recent` 的 `limit` 必须夹取；`memory_read_page` 与 `memory_handoff_accept` 的正文必须带上限与自证截断（`truncated` + 显式分页游标），`/memory/promotions` 必须有跨分区总量帽。截断必须自证，不能把被截断的页报告成完整（同 2026-11-08 的判据）。
- **退役页过滤下沉**：superseded 过滤目前只存在于 `/digest` 的召回路径，MCP `memory_query` / `memory_recent` 会返回已退休页。读面必须共用同一条「什么算活着」的判定。
- **`search_keys` 加权档位可用**：该字段从未写进 frontmatter，读取侧却按 ×2 计分，导致字段加权实际只有 title×3 / body×1 两档。写入与读取必须落在同一处。
- **回合内 `/digest` 一次**：fleet 车道一回合串行请求 own / shared / legacy 三次，各带 9s 超时，每次内部全量读 L2 与向量。合并为一次多根读取（或至少并行），延迟与读放大同时收敛。
- **评测闸门可执行**：`memory-eval` 要求的 headroom 校准胜率与全集非劣率必须进脚本可执行判据；场景集要有能触发 note-depth 臂的深场景；基线要落到可复算、可入库的位置。当前 21 个合成场景 note 最多 2 条，note-depth 臂恒为 vacuous PASS。
- 顺序上先收口（低风险、同型），再改一致性，再补评测闸门，最后才动融合权重——改融合前必须先有能判好坏的尺子。

## Capabilities

### New Capabilities

（无。本变更不引入新能力，只收紧既有读面与评测契约。）

### Modified Capabilities

- `memory-surface-hardening`: 读面的返回上限从「个别工具已夹取」收紧为「每个读面都有上限且截断自证」；退役页过滤从单条召回路径下沉为读面共用判定；`/digest` 的每回合调用形状从「按根串行多次」改为「一次多根」。
- `memory-eval`: 硬门判定从「全集胜率 + 胜平率」改为 spec 已声明的「headroom 校准胜率 ≥70% + 全集非劣（≥ none−1）≥70%」，并要求基线可落库复算、场景集能实际触发 note-depth 臂。

## Impact

- **fd-memory 服务仓**：`src/mcp.ts`（9 个工具的上限与截断自证）、`src/db.ts`（supersede 过滤与查询上界）、`src/http.ts`（`/memory/promotions` 总量帽、`/digest` 多根形状）、`src/distill.ts` / `src/distill-scheduler.ts`（`search_keys` 与融合权重，仅在评测闸门补齐后动）、`scripts/eval-continue.mjs` 与 `fixtures/eval/*`。
- **SDK / 客户端**：`sdk/src/facts.ts` 的 `/digest` 调用形状（三次 → 一次）。这会改已发布 SDK 的行为，属对外契约变化，需要版本前滚与兼容读。
- **平台侧**：`paas/server/fleet-context.js`（2400 字符二次截断与记忆段的共享池）、`paas/cron.js`（fire 前 await 的位置）。
- **不影响**：免费纪律（无计量/付费墙/授权闸）、存储形态（markdown 真源 + SQLite 派生）、发布包命名与许可。
