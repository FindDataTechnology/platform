# add-sub2api-fork-concurrency Design

## AIMD 状态机（per upstream account）
```
states: closed → (failures ≥ N) → open → (cooldown 过) → half_open → (probe ok) → closed
                                     ↘ (probe fail) → open (cooldown ×2 指数退避, 上限 10min)

并发窗口: c ∈ [1, max]
  success: c = min(c + 1, max)          # additive increase
  5xx/timeout: c = max(1, c / 2)        # multiplicative decrease
  queue_full: 不动 c（只拒新请求）
```

## 队列几何
```
请求 → [每账号信号量 c] → 上游
         ↓ 满（等待者 ≥ queueBound）
       429 queue_full + Retry-After: min(2s, halfOpenIn)
```

## 配置
```env
UPSTREAM_CONCURRENCY_MAX=8          # 每账号并发上限
UPSTREAM_QUEUE_BOUND=32             # 每账号队列深度
UPSTREAM_AIMD_ENABLED=true          # AIMD 开关（关=静态并发，旧行为+有界队列仍生效）
UPSTREAM_BREAKER_THRESHOLD=5        # 连续失败→open
UPSTREAM_BREAKER_COOLDOWN_MS=30000  # open 初始冷却
```

## 集成点
- `relay` 转发循环（信号量包裹上游调用）
- `channel_monitor`：新哨兵读 aimd_state（真状态，非 SQL 猜形）
- metrics: `sub2api_upstream_queue_depth` / `sub2api_upstream_queue_rejected_total` / `sub2api_upstream_aimd_concurrency`

## 风险与回退
- UPSTREAM_AIMD_ENABLED=false 一键回旧行为（有界队列保留）
- patch 单文件、与既有 fork patches 同 merge-window 流程
