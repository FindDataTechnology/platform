# debounce-zhiyu-fleet-health-events

## Why

生产实证（`/data/cells/zhiyu.db`，2026-11-10）：一间已结束的团队订阅房堆了 **193 条健康事件行**（105「异常」/ 88「恢复」），三天内来回翻。量化后不是"迁移多"，而是**抖动快**：相邻两次翻转的间隔中位数 **5.8 分钟**，**65% 的翻转在 10 分钟内翻回去**。

频控按 spec 是对的（10 条/小时上限），这类抖动约 3-10 条/小时恰好卡在阈值下，于是逐条如实落——房间里看到的是一串「异常（1 岗）」「恢复」的乒乓，把真正的信号（持续失联、持续恢复）埋掉。spec 的原话是「密集窗口 SHALL 合并为一条摘要行，MUST NOT 刷屏」，抖动属于密集窗口同族，只是当前实现只按条数合并、不按"是否持续"合并。

## What Changes

- 健康状态迁移改为**按持续态报**：一次迁移只有在下一次采样仍保持同一状态、且持续达到设定窗口（`ZHIYU_HEALTH_SETTLE_MS`，默认 **10 分钟**）后才流入房间；窗口内翻回原态的抖动 SHALL **不逐条流入**，只计数。
- 被抑制的抖动 SHALL **如实标注**：下一次真正流入的健康行尾注「（其间抖动 k 次已合并）」；计数随该行清零（沿用既有「熔断期丢弃」的诚实纪律句式）。
- 抖动状态随订阅水位线持久化（与 `reportAt/decisionsCount/abnormalCount` 同一行），因此进程重启不丢"正在观察中的迁移"，也不会因重启把抖动判成持续态。
- 结束房期间照旧只推进水位线不渲染；重开时**不补发**断流期的迁移，且清空观察中的 pending（否则恢复后会立刻把断流期的旧状态当成新迁移报出来）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `fleet-room-bridge`：`事件流入有频控且如实降级` 增加"健康迁移以持续态为准 + 抖动合并计数如实标注"的要求；既有 10 条/小时合并与熔断丢弃语义不变。

## Impact

- 代码：`gateway/fleet-room-bridge.js`（health 分支的 pending/settle 判定 + 尾注）、`gateway/zhiyu/store.js` 的 watermark JSON 形状（`healthPending`/`healthFlaps`，向后兼容：缺字段视作无 pending）。
- 测试：`scripts/test-zhiyu-room-lifecycle.mjs` 增 3 例（抖动被合并只报计数、持续态到窗口才流入、重开不补发且清 pending），用可注入时钟避免 sleep。
- 不改报数/拍板两条通道；不动 10 条/小时合并阈值；不改 schema 列（沿用 `watermark` 列内的 JSON）。
