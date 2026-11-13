# add-write-triggered-distill — Design

## D1 通知通道：buildTools 可选 notify 回调

`buildTools(scope, root, grants)` 增可选第 4 参 `notify?: (rootKey: string, project: string) => void`。`memory_write_page` 与 `memory_handoff_begin` 的 handler 在成功写页/建交接后调用 `notify?.(rootKeyForNamespace(scope.namespace), project)`。http.ts 的 MCP 会话组装点（tools() 工厂，http.ts:522）接线：`(rk, p) => this.distill.notifyCapture(rk, p, [{ event: "session-end" }])`——复用既有 notifyCapture（isDistillableRoot 闸与 FD_MEMORY_DISTILL_U 总闸自动生效）。不传 notify 的调用方（既有测试、其他组装点）零行为变化。

## D2 u- 根短去抖

`distill-scheduler.ts` 增 `U_DEBOUNCE_MS = 60_000`；drain 的就绪过滤按根族取去抖：`u-` → 60s，`d-` → 既有 5min。语义：连续写合并（60s 窗口内多次 note 写 = 一次蒸馏），写后最迟 ~2 分钟（60s 去抖 + 1min drain tick）蒸馏可用。fallback 周期扫描照旧兜底（通知丢失不丢原料；cursor 幂等防重蒸馏）。

## D3 测试

- mcp 层：write_page/handoff_begin 成功后 notify 被调（携带 rootKey+project）；失败路径（权限拒绝）不调。
- 调度层：u- 根 60s 去抖 vs d- 根 5min（注入假 now）；notify 进 pending 后 drain 到期即蒸馏。

## D4 验收

真机：对 bench 根写一条新 note → 观察 `[distill]` 日志在 ~2 分钟内出现（对比 fallback 的 10 分钟）→ /digest 召回该 note 蒸馏产物。
