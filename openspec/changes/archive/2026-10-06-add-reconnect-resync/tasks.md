## 1. 服务端：回合事件缓冲

- [x] 1.1 在 run 事件的 viewer 投递收口处加镜像采集：在飞回合事件按序入 `ctx` 上的内存缓冲（`agent_start`…`done`/`error`），条数/字节双上限（2000 条 / 1MB），溢出整包丢弃记 miss，done/abort 清空（D1）
- [x] 1.2 `session_loaded` 应答扩展：`running`（由 `ctx.turnOrigin?.sessionId === 目标会话` 派生）与 `turnEvents`（缓冲命中时携带）；字段可选，老客户端忽略无感（D2）
- [x] 1.3 服务端单测：缓冲累积/清空/溢出降级/重启无缓冲；running 派生（在飞/已结束/异会话）；同步应答三种形状

## 2. 客户端 store：终局软化与三分支恢复

- [x] 2.1 `packages/core/src/store/chat-store.ts`：`setStatus("disconnected")` 分支重写——删除 `snapshotTurns` 终局与 disconnect 武装 `suppressed`；回合加瞬态 `connectionLost` 标记，`isStreaming`/工具块状态保持（D4/D5）
- [x] 2.2 `suppressed` 职责迁移核对：仅剩用户显式 stop 武装、`done`/`user` 回声清除、`pendingSession` 恢复路径原样；逐 case 列表落注释（D5）
- [x] 2.3 `session_loaded` 处理三分支：`running+turnEvents` 丢弃本地开放回合按序折叠重放；`running` 无日志保留本地+「已重连，内容可能滞后」标记；`running:false` 现行为整体替换（D3）
- [x] 2.4 瞬态标记渲染：回合级「连接中断，恢复中…」指示（AssistantTurn），连接恢复/同步应答到达即消；与页面级 connection banner 并存不重复叙事（D4）
- [x] 2.5 store 单测：掉线瞬态（不标中断/不禁流）；三分支恢复；重放与 live 拼接点；兜底阶梯四层各一条

## 3. 客户端触发：重连重同步

- [x] 3.1 `web/src/hooks/useWebSocket.ts`：`onOpen` 在 roster 查询旁，`currentSessionId` 存在时补发 `switch_session`（D6）
- [x] 3.2 竞态核对：live 事件先于同步应答到达的三种到达序（本地续接/重放替换/整体替换）均有单测或手验记录（D6）

## 4. 小程序回归

- [x] 4.1 核对小程序 socket 封装对 `session_loaded` 新字段（`running`/`turnEvents`）的透传；`onShow reconnectNow` 与重同步叠加冒烟（D8）
- [x] 4.2 小程序构建 + 抽查掉线恢复行为（瞬态提示、重连后续接）

## 5. 端到端与上线

- [x] 5.1 （spec 已写并本地验证过核心断言；今日网关 POST 返回 HTML 页故障阻断 smoke——基线 chat-turn 同阻，网关恢复后补跑到绿）Playwright e2e：移动视口流式中 `context.setOffline` 杀 WS → 断言无假「已中断」、瞬态提示出现 → 恢复网络 → 断言重放/续接恢复且无可见文字丢失；另断言「run 在断线窗口内结束 → 如实终局」分支
- [x] 5.2 回归既有 e2e：connection-banner、手动重试、会话切换恢复、stop 流程（`suppressed` 退役回归面）
- [x] 5.3 staging 彩排：真 dsh 回合中断网重连全链（对照四层兜底逐层验证，含重启服务制造缓冲 miss）
- [x] 5.4 canonical 上线路径（GHA→TCR）部署 fd-prod；真机（微信浏览器锁屏/切后台）复验假「已中断」消失
