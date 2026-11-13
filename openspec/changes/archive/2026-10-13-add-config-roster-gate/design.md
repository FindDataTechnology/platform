# Design: add-config-roster-gate

## Context

- configWriteCore（gateway/packs.js:1915+）：model 写在 PUT 前过 shape→lane 两层（1954-1975）；随后 GET-merge-PUT（1982 GET entry → merge config_overrides → 2000 PUT）。
- GET 的 entry.metadata.runner_id 即宿主归属（部署时 deployToRegistry 打标；未打标=fleet 默认行 rows[0]）。
- scheduler.boardNow（≤10s 缓存）与 registry.runnerList 在同一闭包作用域。
- 生产现患：wx-alpha 在役 effective_model=inclusionai/ling-3.1-flash（不在 8 项花名册）——每回合 UNKNOWN_MODEL 静默空返照计费。其余 9 条目全在册或走默认。

## Goals / Non-Goals

**Goals**：配置面 model 写三层门补 roster；wx-alpha 现患清零（清 null 回落默认）。

**Non-Goals**：不做 pack_deployments 落 runner_id 缓存（entry 即事实源，缓存会漂）；不动遗留 effective_model 的批量巡检（审计已做，仅 wx-alpha 一例，产品路径清除）；空返回合采集器识别仍挂账。

## Decisions

1. **门插在 GET 之后 PUT 之前**——runner_id 白捡零额外往返；modelRequested 标志从上层 lane 段带下。
2. **null 清不走门**（`body.model !== undefined && body.model !== null` 才是「选择」——与 lane 段判定逐字一致）；这也让 wx-alpha 的清除操作天然合法。
3. **宿主解析**：`entry.metadata.runner_id ?? runnerList()[0]?.id`——与部署门同式（部署门读 placement，配置面读 entry 现场值，两者对同一部署在稳态下同值；改点波瞬间以 entry 为准，因为它就是 runner 轮询的同源）。
4. **降级开放**：scheduler null / boardNow throw / roster 非数组 → 跳过。与部署门逐字同纪律。

## Risks / Trade-offs

- 配置写多一层对 board 的依赖：降级开放兜底，观测故障不影响写路径可用性。
- wx-alpha 清除后走 runner 默认模型：其原模型选择意图丢失——但该选择本来就不可运行（空返），清除即修复；如部署者日后想要特定模型，从在册清单里选（错误信息带清单）。
