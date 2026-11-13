## Context

现状约束（生产实测，详见 proposal.md - Why）：

- webhook 路由**先 ACK 再处理**（`server/routes/bots.js`：`done(200, "success")` 之后才 `handleMessage`）。因此回合侧的任何等待都不会触发聊天平台重试，等待预算只受 per-chat 队列与用户体验约束。
- bot 回合走 `ctx.dshBridge.prompt(sessionId, blocks)`，`blocks` 目前 = `[挂技能块(仅 pack bot)] + [禁工具前缀+用户文本]`。
- 工具姿态判定是**单一全局 env**（`allowTools() = BOTS_ALLOW_TOOLS === "1"`），同时控制提示词前缀与回复侧 `usedTools` 扣留。
- preset 是 **cell 级持久偏好**（`agent.preset`），切换会重启共享 child（`server/agent-session.js` 注释：dsh 在会话创建时按 preset 组合人格）。bot 会话按 chat 独立、且共享同一 child，因此**不能靠 preset 给单个 bot 人格**。
- 已有先例：`server/cron-runner.js:402` 用 deadline 轮询等待 `isReady()`；`social-bot-channels` 已有「冷启动窗口内的 webhook 不得以确定拒绝丢弃消息」，管的是**注册表未装载**窗口，本次补的是**注册表已装载、runtime 未就绪**窗口。

## Goals / Non-Goals

**Goals:**

- bot 回复的可信度：就绪前不早退、不冒充其他角色、工具面按 bot 分级。
- 改动集中在 `server/bots.js` 一条回合路径，不新增服务、不新增外部依赖。
- 语义可运维：工具姿态能一键全关（部署级）也能单 bot开。

**Non-Goals:**

- 不改 webhook 验签/解密、限流、长度上限、`response_url` 被动回复窗口。
- 不解决「回合进行中 runtime 被滚版杀掉」——那由既有流式标记 + 180s 超时兜底，属另一条线。
- 不引入 per-session preset（需改 dsh 契约，风险与收益不匹配）。
- 不做人格的多语言/模板化，persona 是运营者自由文本。

## Decisions

**D1 就绪等待：deadline 轮询，不是事件订阅。**
`runTurn` 把 `if (!isReady()) return reply("starting up")` 换成有界等待：每 250ms 检查一次 `dshBridge.isReady()`，直到 `BOTS_READY_WAIT_MS`（默认 90_000）耗尽。理由：`dshBridge` 没有暴露 ready promise/事件，轮询是唯一不改契约的路径，且 `cron-runner.js:402` 已有同形状先例可对齐。备选（事件订阅）需要改 bridge 接口，收益仅是省几次 timer。90s 取值依据：冷启动实测 cell `listen` → `runtime ready` 约 40-60s，留 1.5x 余量。

**D2 人格走提示词注入，不走 preset。**
`blocks[0]` = 人格块；pack bot 的挂技能块顺延到 `blocks[1]`；用户文本最后。理由见 Context：preset 是 cell 级、切换会重启共享 child，而 bot 需要 per-chat 会话共存。注入是零契约变更的唯一路径。中性默认文本（未配置时）必须点名 bot 名并显式禁止冒充运营者/舰队副驾/内部工具面——这正是 2026-10-31 事故里「答成 decision_queue」的直接反制。备选（per-session preset）需 dsh 支持会话级 preset，未验证且改动跨仓。

**D3 工具姿态 = per-bot 开关 + 部署级上限（AND 关系）。**
判定收敛成一个函数 `allowToolsFor(bot) = envCeiling && bot.allowTools`，提示词前缀与回复侧扣留**共用同一判定**（避免两处漂移——历史上正是两处一起被同一个 env 抬起）。保留部署级上限的理由：群聊多人可见，部署方需要一个一键全关的安全阀。备选（纯 per-bot 无上限）少一个概念，但失去止血能力；备选（继续单一全局 env）无法按 bot 分级，与「智语」这类对外角色需要的严姿态冲突。

**D4 两个字段进 `bots` 表，不进 `credentials` JSON。**
`persona TEXT NULL`、`allow_tools INTEGER NOT NULL DEFAULT 0`。理由：`credentials` 是密钥面（`maskBot` 只透出 key 名、不透值，前端拿它显示「已配置」），把公开人格混进去会让该提示失真；且凭据轮换是**整对象替换**（历史坑：单键 PUT 会抹掉同对象其它键），人格不该住在会被整体覆盖的对象里。迁移沿用现有 schema 版本机制。

**D5 冷启动日志要能判读。**
等待超时与回合失败必须是两条可区分的日志（沿用 `social-bot-channels`「回复成功必须留下可判读的痕迹」的判读口径）：超时那条要写清「等了多少毫秒仍未就绪」，回合失败那条沿用既有 `turn failed:` 形状。

## Risks / Trade-offs

- [等待占用 per-chat 队列：同 chat 后续消息排队] → 预算有界（90s 上限），且队列本就是串行设计，最坏是延迟而非丢失。
- [人格块挤占提示词预算] → 中性默认保持短句；persona 由运营者自写，表单给出长度建议；沿用现有 `contextBudget` 口径计费。
- [**BREAKING**：`BOTS_ALLOW_TOOLS` 语义从「全 bot 开」变成「部署上限」] → 迁移默认 `allow_tools=0`，生产若保留 env=1，现有 bot 会立刻失去工具；发布顺序为「先上代码（默认关）→ 按 bot 显式开」，并把「生产 env 处置」列为 tasks 里的一条运维动作而非代码行为。
- [两处工具判定漂移（前缀 vs 扣留）] → 收敛到 `allowToolsFor(bot)` 单一函数，测试同时断言两条路径。
- [人格注入被模型忽略] → 无法强保证；但中性默认把「不要冒充内部角色」写进首块，配合工具默认关闭，事故路径已被双重掐断。

## Migration Plan

1. 迁移加两列（`persona` 可空、`allow_tools` 默认 0）；旧行自动落到「无 persona + 禁工具」。
2. 代码落地：`allowToolsFor(bot)` 替换 `allowTools()`；`runTurn` 加等待 + 人格块。
3. 管理面：`maskBot` 透出两字段，CRUD 接受两字段，bots 表单加输入。
4. 出片后运维动作：决定生产 `BOTS_ALLOW_TOOLS` 去留——摘掉即「全 bot 禁工具」（恢复 spec 原姿态）；保留则逐个 bot 打开 `allow_tools`。
5. 回滚：镜像退回即可；新增两列保留无害（旧代码不读），`allow_tools` 默认 0 与旧行为（无 env 时禁工具）一致。

## Open Questions

（无——三处行为语义均已在提案阶段拍定；人格文本内容属运营输入，不构成设计未知。）
