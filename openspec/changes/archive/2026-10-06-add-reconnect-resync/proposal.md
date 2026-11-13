## Why

移动端对话中频繁出现假「已中断」：WS 掉线（锁屏/切后台/换网）的瞬间，客户端把在飞回合终局标红「已中断」并武装 `suppressed` 吞掉后续事件 —— 但回合是服务端权威的，掉线后照跑；重连后服务端按-viewer投递其实能把事件送达新 socket，却被客户端主动丢弃。用户刷新（触发 `switch_session` → `session_loaded` 整体替换转录）才能看到真相。根问题：**在飞回合的视图是一条不可重放的直播流**（转录只在回合结束落库，`agent-session.js:552/607`），客户端因此把「socket 掉了」误当「回合死了」。当年这个终局是为修「isStreaming 永久卡死」加的（`packages/core/src/store/chat-store.ts` `setStatus` 分支），方向正确但仲裁权放错了端。

## What Changes

- **服务端回合事件缓冲（R1 根机制）**：为在飞回合在内存维护有上限的原始事件日志，done 即清；`switch_session` 的 `session_loaded` 应答扩展携带 `running` 标志（由 `ctx.turnOrigin` 派生）—— `running:true` 且缓冲命中时附带回合事件日志，客户端重放重建在飞回合后续接直播。
- **客户端掉线终局软化（B）**：socket 掉线不再把回合标红「已中断」、不再武装事件吞噬；改为瞬态「连接中断，恢复中…」标记，`isStreaming` 保持；终局仲裁权归服务端（重连同步应答 `running:false` 才终局），「已中断」的常规来源只剩用户主动停止。
- **重连重同步（A）**：WS `onOpen` 对当前会话补发 `switch_session`，走上述同步应答；`running:true` + 缓冲 miss（进程重启）时保留本地半截回合标记「已重连，内容可能滞后」，live 续接、done 收敛；`running:false` 按现行为整体替换转录。
- **四层兜底阶梯**：缓冲命中全量重放 → 缓冲 miss 保本地半截 → 彻底断连保持瞬态不假终局（服务端真跑不受影响，随时刷新见真相）→ run 已死则 `session_loaded(running:false)` 如实终局。任何路径都向服务端真相收敛，只是保真度递降；任何路径不得可见地丢失已流出的文字。
- 改动面：`packages/core/src/store/chat-store.ts`（disconnect 分支重写）、`web/src/hooks/useWebSocket.ts`（onOpen 补发 switch_session）、`server/ws.js` + `server/agent-session.js`/`server/dsh-events.js`（事件缓冲与同步应答）。小程序共用 core store，同步受益、必须回归。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `web-chat-server`: 新增服务端契约 —— 在飞回合事件缓冲与重连同步应答（`session_loaded` 携带 `running` 与可重放事件日志，缓冲有上限且 done 即清）。
- `chat-streaming`: 新增客户端流语义 —— socket 掉线不本地终局在飞回合（瞬态重连态 + 服务端仲裁），重连后按同步应答三分支恢复（重放替换 / 保本地续接 / 如实终局）。
- `web-chat-ui`: 修改 WebSocket 生命周期 requirement —— 成功重连后对活动会话触发重同步（原 5 个 scenario 全保留，新增重同步 scenario）。

## Impact

- **协议**：`session_loaded` 加 `running?: boolean` 与 `turnEvents?: ServerMessage[]` 可选字段，向后兼容（老客户端忽略新字段仍按现行为工作）；不改既有事件类型。
- **服务端**：单回合内存缓冲（带上限，如 1MB 事件文本/条数封顶，溢出视同缓冲 miss 走兜底层）；缓冲挂在 `ctx`，随进程生命周期，不落盘（拷问已定：不做持久化）。
- **客户端**：core store 的 `setStatus("disconnected")` 分支语义反转（不终局、不吞事件——`suppressed` 机制随之退役或仅剩明确用户停止场景）；`session_loaded` 处理新增三分支。`packages/core` 被 web 与小程序共用，小程序 socket 封装需确认新字段透传。
- **测试**：store 单测（掉线瞬态、三分支恢复、兜底层）+ 1 条 Playwright e2e（`context.setOffline` 杀 WS 断线重连，断言恢复且无假已中断）+ 小程序回归。
- **风险**：`suppressed` 退役后需确认其承担的其它职责（如用户显式 stop 后孤儿事件吞没）不回归 —— 逐 case 迁移到新语义，任务里有专项核对。
