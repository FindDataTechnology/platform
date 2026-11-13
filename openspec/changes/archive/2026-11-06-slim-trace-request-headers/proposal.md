# slim-trace-request-headers

## Why

cheap-3 DiskPressure 根因调查（2026-11-06）第三层「cell 数据无界」的机制性真因落定：`trace.record()` 把每回合的 `request/header` 事件**原样落库**，其中包括发给模型的完整工具表 schema（本次实测 712 个工具、平均 116KB/回合）——而全部消费方只读其中的 `config.provider`/`config.model`（约 50 字节）用于回合列表的模型归因。`dsh-events.js` 的处理器自己注释着「the full roster can be very large and the host has no other use for it」并在内存里丢弃原始 header，但 trace tap 在该 switch 之前就把整包写进了 trace.db。

量级实证（cheap-3 冷备 cell `1da519d4`，trace.db 2.3G）：`request/header` 9970 行共 **1.1GB**（第一大头，第二名 assistant/message 仅 236MB）；7 天保留 prune 只能删 276 行——数据都在窗口内，**写进来的量级就是错的**。712 工具的 roster 每回合重落一遍（回合间几乎不变），是纯浪费。

unknown-tool 恢复不受影响：`dsh-events.js:449` 的内存投影（parseToolSchemas→turnToolRecords）发生在 trace tap 之后、独立于 trace 存储。

## What Changes

- `server/trace.js` 的 `record()`：event_type 为 `request/header` 时，payload 瘦身为 `{header:{config:{provider,model}}}`（消费方读的就是这两键）；tools 数组与 adapterDefaults 不落库。
- `server/trace.js` 的 turn 列表聚合（header_payload）与 `fleet-runs.js` 的两处读取不变——字段兼容。
- 既有行不回填改写（历史行由 7 天保留自然淘汰）。

## Capabilities

### Modified Capabilities

- `turn-tracing`：bounded storage 要求补「request/header 落库瘦身」条款。
