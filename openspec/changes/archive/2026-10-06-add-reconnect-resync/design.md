## Context

假「已中断」的完整因果链（explore 阶段逐行验证）：

```
移动端锁屏/切后台/换网 → WS 掉线
  → chat-store setStatus("disconnected")（曾为 connected 时）
      snapshotTurns: 流式回合标 interrupted（红条）· 工具块不动（运行中+已中断同框）
      isStreaming=false · suppressed=true（吞 RUN_EVENT）
  → 30s 封顶指数退避重连；服务端 ws.viewedSession=liveId 自动收编新 socket，
    在飞事件其实能送达
  → 客户端 onOpen 只发 list_* 不发 switch_session；suppressed 吞掉续传事件
  → done 到达也只关闭"仍在流式"的尾巴，已终局的半截永不回填
  → 刷新（switch_session → session_loaded 整体替换）才见真相
```

结构性事实：转录只在回合结束落库（`agent-session.js:552/607` `recordMessage`）；在飞回合的客户端视图 = 不可重放的直播流。服务端已有回合在飞判定：`ctx.turnOrigin`（`ws.js:140` 设置，`dsh-events.js:125` done 清空）。`packages/core` 的 chat store 由 web 与小程序共用（`miniapp/src/components/TurnView.tsx:21` 等），小程序自带 socket 封装（`onShow` 走 `reconnectNow`）。

## Goals / Non-Goals

**Goals:**
- 掉线不再产生假终局；「已中断」常规来源只剩用户主动停止。
- 重连后在飞回合以最高可用保真度恢复：缓冲命中全量重放 ≥ 缓冲 miss 保本地续接 ≥ 彻底断连保持瞬态；任何路径不得可见地丢已流出的文字，全部向服务端真相收敛。
- 向后兼容：老客户端（含小程序旧版）忽略新字段仍按现行为工作。

**Non-Goals:**
- 不做事件序列号/游标续传协议（R3）——单 dsh 运行时、回合串行的规模下 R1 用 20% 复杂度覆盖 95% 价值；R3 的截断兜底本就退化为 R1 的全量重放。
- 缓冲不落盘持久化（拷问已定：进程重启走 miss 兜底，不做落盘/清理机制）。
- 不做多租户/多 dsh 并发回合的缓冲管理（当前一次一回合）。
- 不动 per-viewer 投递模型、不动会话所有权门禁。

## Decisions

- **D1 根机制 = R1 服务端回合事件缓冲 + 重放**。缓冲挂在 `ctx`，从 viewer 投递的同一发射点镜像采集（`dsh-events.js` 与 `agent-session.js` 的 `sendToViewers` 调用侧统一收口，避免第二套采集逻辑漂移）。上限：事件条数 + 序列化字节数双封顶（初值 2000 条 / 1MB，常量可调），溢出即整包丢弃视同 miss。done/abort 清空。
- **D2 同步应答契约**：复用 `session_loaded`，加可选 `running: boolean` 与 `turnEvents: ServerMessage[]`。`running` 由 `ctx.turnOrigin?.sessionId === 目标会话` 派生。字段可选 ⇒ 老客户端零感知。不新建消息类型（`session_sync`）——少一条协议分支，且 switch_session 已有所有权门禁与 plan/question 恢复搭车。
- **D3 客户端三分支**（`running`×缓冲）：
  - `running:true + turnEvents` → 丢弃本地开放回合、按序折叠重放事件重建、续接直播。重放内容从回合起点开始 ⇒ ≥ 本地半截，不会闪没（这是对拷问第二轮「保序不替换」的落地：替换仅发生在内容只会变多的情况）。
  - `running:true 无 turnEvents` → 保留本地半截回合 + 「已重连，内容可能滞后」标记，live 续接，done 收敛（转录落库后下次加载即完整）。
  - `running:false` → 现行为整体替换（真终局，转录含断线窗口内完成的全量文本）。
- **D4 掉线终局软化**：`setStatus("disconnected")` 的 `snapshotTurns`/`suppressed` 路径删除；回合带瞬态 `connectionLost` 标记（渲染为「连接中断，恢复中…」，连接恢复或同步应答到达即消），`isStreaming` 保持，工具块状态不动。页面级 connection banner（`ChatPage`）原样保留，两者不冲突（banner 说 socket，turn 标记说内容恢复）。
- **D5 `suppressed` 退役与职责迁移**：逐 case 核对其现有职责——①掉线孤儿事件吞没（本变更直接消灭该场景）②用户显式 stop 后的迟到事件吞没（保留：改为仅由 stop 动作武装，`done`/下一 `user` 回声清除，语义不变）③switch 中断兜底（`pendingSession` 恢复路径保留原逻辑）。即：suppressed 不再由 disconnect 武装，其余武装源原样。
- **D6 重连触发重同步**：`useWebSocket` 的 `onOpen` 在既有 roster 查询旁，`currentSessionId` 存在时补发 `switch_session`（`resync:true`，经 `client.send` 直发——不走会触发乐观翻转的 choke point）。竞态：服务端连接即收编 viewedSession，个别 live 事件可能先于同步应答到达——因 D4 后不再吞事件，这些事件落在本地开放回合上继续追加（正确）；随后 `running:true + turnEvents` 的重放替换以服务端为准（正确）；`running:false` 整体替换（正确）。三种到达序都收敛。
- **D6.1 resync 应答只发请求者（实现期修正）**：初版把 resync 的 session_loaded/plan/question 走 `sendToViewers` 广播给同会话全部查看者、且复用了 `broadcastSessions`——多页面/会话敏感 e2e 成批红（stash 对照定位为本改动所致）。修正：`resync:true` 的两条路径（免导航分支 + 同会话快路径）全部改为 `sendIfOpen(ws, ...)` 请求者直达，且跳过 `broadcastSessions`/`session_changed`（resync 不改变列表可见状态）。用户显式切换（无 resync 标志）保持原广播语义。
- **D7 终局仲裁权 = 服务端，无本地硬超时**（拷问已定）。彻底断连时保持瞬态 + 停止键可用；用户停止走现路径如实标中断。
- **D8 小程序**：core store 改动自动受益（瞬态语义、三分支恢复）；小程序 socket 封装确认 `session_loaded` 新字段透传到 `apply`（预期透传，逐行核对）；`onShow reconnectNow` 与重同步叠加行为冒烟。

## Risks / Trade-offs

- **缓冲内存**：单回合 ≤1MB、done 即清、进程内单体——上限可控；溢出/重启走兜底层不炸。
- **重放折叠的正确性**：客户端 fold 逻辑对事件序的假设（如 `agent_start` 先于 `text`）在重放与直播中一致，因为重放的就是原始发射序；需单测覆盖「重放到一半又来 live 事件」的拼接点。
- **`suppressed` 退役回归面**：它是两次历史 bug 的修复产物（isStreaming 永久卡死、孤儿事件）。D5 的逐 case 迁移 + 原 e2e 回归（connection-banner / 重试按钮 / switch 恢复）是验收硬门槛。
- **双端节奏**：web 先行（onOpen 重同步在 web hook），小程序核对后跟进；协议向后兼容使两端不必同版本上线。
- **`recordMessage` 仅在回合结束落库**：缓冲 miss 层的「暂缺-收敛」体验是已知取舍（拷问已接受）；若后续要消灭，另立 change（落盘缓冲或 dsh 会话文件读取），本变更不扩。
