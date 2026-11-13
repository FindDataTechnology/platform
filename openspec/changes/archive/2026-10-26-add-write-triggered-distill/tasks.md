# add-write-triggered-distill — Tasks

## 1. fd-memory 实现

- [x] 1.1 `mcp.ts`：buildTools 可选 `notify` 参数；memory_write_page / memory_handoff_begin 成功后调用（rootKey+project）
- [x] 1.2 `http.ts`：MCP 会话组装点接线 notify → distill.notifyCapture(session-end)；`distill-scheduler.ts`：U_DEBOUNCE_MS=60s，drain 按根族取去抖
- [x] 1.3 单测：notify 触发与失败路径不触发；u- 60s vs d- 5min 去抖（假 now）；写后到期蒸馏

## 2. 出片与验收

- [x] 2.1 出片滚产（标准线）
- [x] 2.2 真机：bench 根写新 note → ~2 分钟内 `[distill]` 眼见 → /digest 召回
- [x] 2.3 台账回填 + 归档
