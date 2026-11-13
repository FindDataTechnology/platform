# Design: add-pack-usage-telemetry

## Context

见 proposal.md - Why。锚点：回合完成钩子 `ctx.finishTurn`（server/dsh-events.js:129，`session.status idle` 与流错误双入口收敛于此）；会话的当前 agent 在 `ctx.currentAgentId`（server/agent-session.js:400）；agent→pack 归属经 catalog 条目解析（`catalog.getChatAgentEntries()`，实现期确认 pack 字段的确切访问器）；ops 台先例 = services/ops-console（env TOKEN bearer 门 + 板块源模式，如 fleetBoard）。

## Goals / Non-Goals

**Goals:**
- 每回合一行用量（pack 维度），failure-isolated。
- 7 天窗聚合 = 周活跃判据的直接答案；ops 凭据门。
- 有界存储（定时修剪 + 空间回收）。

**Non-Goals:**
- token/成本计量（LLM 侧已有 sub2api 账）；CSV 导出；历史回填；用户面任何变化。

## Decisions

- **D1 存储落主库**：新表进 cell 主 app 库（getDb），非 trace.db——trace 是 7 天有界调试面（契约不同：delta 丢弃、按需摘要），用量是 180 天聚合面。表：`pack_usage_events (ts, user_email, session_id, agent_id, pack_id NULLABLE, outcome, duration_ms)` + ts 索引。
- **D2 打点在 finishTurn**：一个钩子覆盖 idle 收口与错误收口两条路径；用户身份取 ws 会话的 user（email）；时长从回合开始戳（ctx 已有 streaming 起点字段，实现期对齐）。`try/catch` 全包裹——沿 trace.js 的 failure-isolation 纪律。
- **D3 pack 解析**：`ctx.currentAgentId` → catalog 条目 → pack 归属；local / 自建预设（无 catalog 条目）→ pack_id 为 NULL。解析失败记 NULL 行而非丢行（宁缺维度不缺事实）。
- **D4 聚合 SQL**：`GROUP BY pack_id` + `COUNT(DISTINCT user_email)` + `MAX(ts)`；NULL pack 单列。端点 `GET /api/ops/pack-usage?days=`，days 夹取 [1,365]。
- **D5 ops 门沿既有 ops 台凭据**（services/ops-console 同源 TOKEN 纪律：bearer env token；平台侧该端点的门 = 既有 ops 路由族的鉴权先例，实现期就近复用，不新发明）。
- **D6 修剪**：小时级 timer + `auto_vacuum=INCREMENTAL` 后 vacuum——照抄 trace.js 的 2026-10-10 事故教训（boot-only prune 在长驻 cell 上永不触发）。

## Open Questions

- ops-console 板块的数据通道：直连平台 `/api/ops/pack-usage`（新 env URL+TOKEN）vs 并入既有 platform-board 源——实现期看 ops-console 现有源接线就近落，倾向后者（少一个 env 对）。

## Risks / Trade-offs

- 每回合一行的写入量 ≈ 会话量级（远低于 trace 事件流），主库无压力；聚合查询有 ts 索引 + 180 天窗。
- 多 cell 部署下"内部用量"分散在各 cell 库——v1 聚合面是单 cell 的；跨 cell 汇总若 M1 后有需要，走 ops 台多源（同 fleet 板先例）再加。
