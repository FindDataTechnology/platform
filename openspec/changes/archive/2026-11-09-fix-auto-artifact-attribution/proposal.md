# fix-auto-artifact-attribution

## Why

共享浏览器服务的自动命名产物靠「mtime ≥ 调用起始时刻」判定归属（`newFilesSince`）。这个判据拿**墙上时钟**去比**文件系统时间戳**，而文件系统会把 mtime 向下取整到自己的 tick（Linux 常见 1–10ms，某些 overlay/tmpfs 更粗）。

后果是真实的跨 cell 泄漏，不是洁癖：一次快速调用写下的 `auto-*.png` 可能带一个早于 `startedAt` 的 mtime → 不被认领 → 留在共享根目录 → 被**下一个 cell 的调用**扫进它的目录。`browser-lane-service` 的「浏览器产物按 cell 可读性路由」明确禁止这件事。

2026-11-08 的 CI 基线把它暴露成一条 only-on-Linux 的红：`scripts/test-browser-lane-service.mjs` 的「1.5 + 4.2 screenshots land in the calling cell's workspace」断言 `the unnamed shot must be adopted by the calling cell, has cell-a.png` —— macOS（ns 精度）连跑三次全绿，ubuntu runner（tick 取整）稳定红。这正是「本地绿、CI 红」的典型形态：不是产品在两地不同，而是判据本身依赖时间戳精度。

## What Changes

- **归属判定改为名字快照差分**：调用开始前记下共享根目录的文件名集合（`listArtifactNames`），调用结束后凡「名字不在快照里」的文件即为本次产物，与时钟无关。`adoptNewFiles` / `newFilesSince` 增加可选 `before`；不给快照时仍退回原有的 mtime 判据（保持兼容）。
- **服务侧接上快照**：`forwardCall` 在调用上游之前取快照，认领时一并传入。
- **测试**：新增 `scripts/test-browser-lane-artifacts.mjs` —— 用 `utimesSync` 把文件 mtime 人为压到 `sinceMs` 之前，**确定性地复现 CI 的那条红**（无快照 → 不认领、文件留在共享根）；同一 fixture 加上快照 → 正确认领。另有「调用前就存在的文件不认领」「同名冲突加数字后缀不覆盖」「目录不认领」三例。

## Capabilities

### Modified Capabilities

- `browser-lane-service`：产物归属的判定依据从「时间窗」改为「调用前的名字快照」，并新增一条场景要求粗粒度时间戳不得改变归属、共享根不得残留。

## Impact

- **代码**：`lib/browser-lane-artifacts.js`（新增 `listArtifactNames`，`newFilesSince`/`adoptNewFiles` 各加一个可选参数）、`server/browser-lane-service.js`（`forwardCall` 取快照并传入）。
- **行为**：并发调用之间的归属仍按「谁先扫到」的既有语义；本 change 只消除「因时间戳精度而漏认领」这一类。
- **测试**：新增 5 例；既有 `test-browser-lane-service.mjs` 11/11 保持绿。
- **出片**：纯服务端逻辑，随下次 paas 出片生效。

## 非目标

- 不改自动命名的文件名格式，也不改同名冲突的后缀规则。
- 不改「共享服务按 pod 部署一份」「每 cell 独立浏览器状态」等相邻需求。
- 不做并发调用的严格串行化（那是另一个话题）。
