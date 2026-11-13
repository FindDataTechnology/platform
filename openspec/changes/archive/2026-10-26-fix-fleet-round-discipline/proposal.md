# fix-fleet-round-discipline Proposal

## Why

2026-10-24 深夜营销舰自动化 9 连败，实锤三条平台面缺陷（均钉到具体代码行）：

1. **凭据变更重启不等回合边界**：交付控制器的忙判定 `isStreaming: () => Boolean(ctx.isStreaming)`（server.js:735）只看 web 活回合，看不见注册在 `ctx.sessionCollectors` / `ctx.taskTurnRegistry` 上的舰队 cron 回合——凭据恰好在巡逻回合流式中变更时被判「闲」，立即 `dshBridge.restart` 当场打断在途回合。且硬顶 5 分钟 < 舰队回合预算 10 分钟，谓词修好后硬顶仍会在回合中途强推重启。
2. **舰队 cron 会话无限累积**：任务创建时一次性铸造 `sessionId: cron-<id>`（cron.js:299）且永不更换，dsh 子进程按 id 逐回合从磁盘续命全部历史——5 回合 2.3MB，每回合先花数百秒压缩旧账吃光 600 秒预算。设计面（`{{fleetContext}}` 每回合现算末次报数）明明是无状态的，实现却按有状态累积。
3. **swap「清史重开」对 cron 会话不生效**：`chatHistory.deleteSession` 的 dsh 侧清理是 best-effort 且预期可失败被吞（chat-history.js:443-447；dsh-bridge.js:358 对 0.0.1-rc.1 无 `session/delete` RPC 即吞掉），活会话是子进程自己持久化的那份；swap 后任务续用同一 sessionId（fleet-reconcile 明文「bound session never changes」），下一回合旧账原样续上。

修复 A/B 后，噪音 D（模型幻觉工具名、冷启动首轮失败）的出现频率预期大幅下降，不需另行立项。

## What Changes

- **交付控制器的忙判定升级为「共享子进程忙」谓词**：web 活回合 + 共享子进程上一切收集器注册的在途回合（cron/委托/bot-relay）任一为真即推迟；硬顶提到 ≥ 共享子进程最长回合预算；`dshUpdateMcp` 末端兜底裸 restart 路径同样收进控制器。
- **舰队成员回合的「子进程对话 id」与宿主会话 id 解耦并按回合轮换**：每回合以 `cron-<id>#r<startedAt>` 的新对话 id 对子进程 prompt 与收集，镜像行仍落在稳定的 `cron-<id>` 会话下（`collectTurn` 增可选 `mirrorSessionId`）；回合收尾对本回合子进程对话做 best-effort 回收。a2a/tool 岗位不碰主子进程，不参与轮换。
- **swap 清史重开改为可验证语义**：freshSession 的效果以「下一回合子进程对话必为全新 id/空会话」钉住（靠轮换原语，不依赖 `session/delete` 的支持度），并补单测。

## Capabilities

### New Capabilities

（无——三条缺陷全部落在本仓既有能力的规格收紧上。）

### Modified Capabilities

- `mcp-integration`：「凭据形 patch 变化的一切交付路径同受交付控制器管辖」——忙判定 SHALL 覆盖共享子进程上的全部在途回合（不止 web 活回合）；硬顶 SHALL ≥ 该子进程最长回合预算；一切可落 restart 的 patch 交付路径 SHALL 经过控制器（含快照不可比兜底与「无服务器/hot-swap 关闭」兜底）。
- `cron-module`：定时任务「一次触发 = 绑定会话中一个回合」的语义细化——舰队成员岗位（携带 sourceTag.fleetId 的任务）的回合 SHALL 逐回合以全新子进程对话执行（回合无状态，镜像累积供读），普通定时任务语义不变。
- `agent-fleet-core`：「换防默认继承可选清史」——清史重开的验收口径收紧为「下一回合在全新子进程对话上执行」，即使运行时不支持会话删除 RPC 亦然；岗位镜像会话清空重建而报数史与 KPI 槽位连续性不受影响（不变）。

## Impact

- 代码：`server.js`（谓词接线 + 硬顶 + 兜底路径）、`server/dsh-mcp-delivery.js`（谓词语义注释/常量）、`server/cron-runner.js`（轮换 + `mirrorSessionId` + 回合收尾回收）、`server/routes/fleets.js`（swap 清史走轮换语义）、`chat-history.js`（`collectTurn` 镜像参数；`deleteSession` 行为不变）。
- 测试：`scripts/test-*.mjs` 新增控制器忙矩阵、轮换原语、swap 清史三组单测；既有 cron-runner 相关单测需核对收集器键假设。
- 不改 dsh 侧协议（不依赖也不要求 `session/delete` 支持）；不改 worker 槽位（各自独立 bridge，天然不受主子进程重启影响）。
- 上产后现存 2.3MB 级旧会话因轮换自动「断粮」，无需数据迁移；子进程侧孤儿文件由逐回合回收 best-effort 清理，磁盘增量有界。
