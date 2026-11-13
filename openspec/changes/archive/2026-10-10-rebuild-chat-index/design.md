# rebuild-chat-index — Design

## Context

事故与数据现状见 proposal.md。本设计只记录**已在生产数据上验证过的事实**与据此定下的规则——重建不是推测出来的映射，而是对活库逐字节对拍过的同一套语义。

关键既有事实（2026-10-10 实测，只读核查）：

- **转录形状**：`dsh/sessions/<scope>/<sessionId>/session.jsonl.zstd` 是**多帧 zstd 拼接的 JSON Lines**；`zstdcat` 可全量解出，node 侧 `zlib.zstdDecompressSync` 只解第一帧（`scripts/inspect-live-session.mjs` 已按 magic 分帧的范式，重建工具复用该手法）。
- **镜像语义（已对拍验证）**：以 platform-test cell（`3fdc7b8e8ac03b68`）为活标本，按其转录重建后与现存 SQLite **14/14 会话逐字节一致**（含 `blocks` 的 `args`/`result`/`state`、`title`、`agent_preset`、`workspace`）。规则：
  - `user` 行 = `agent/inbox/spliced` 的 `inserted[]` 与 `user/message` 事件中 `source.kind == "user"` 者，按事件 `id` 去重（同一条消息两个事件都出现，实测 13/14 会话 id 与文本双匹配）；子代理回传（`subagent-settled` 等）不算用户消息。
  - `assistant` 行 = `assistant/message` 且（`content` 有 text 或本轮累计工具块非空）时落一行；正文 = `content[]` 中 `type=="text"` 的拼接。
  - `blocks` = 本轮（`turn/start` 起）`tool/call` 累计的 `{kind:"tool", id:callId, name, args}`（`arguments` 是 JSON 字符串，需 parse；parse 失败保留原字符串）+ 末尾若有 text 追加 `{kind:"text", text}`；`tool/result` 按 `callId` 回填 `result`（取 `data.message.content[0].content[].text` 拼接，null 表示无正文）与 `state`（`isError` → `error`/`done`）。
  - `title` = 首条用户消息按 `truncateTitle`（60 字符 + 省略号、换行归一为空格）；`agent_preset`/`workspace` 取转录头 `{"type":"session"}` 的 `agentPreset` / `cwd`；时间戳取事件 `time`（毫秒）。
- **范围与规模（小说 cell 实测，dry-run 复核定稿）**：顶层 109 个（`--app--` 53、`--data-workspace--` 15、当前 workspace 41），子代理 1665 个（depth 1/2/3 = 1582/73/10）；老库（迁移原件）含该用户 75 行、他人 4 行。**并集 125 个会话**（109 个有转录 + 16 个仅老库）、**5,104 条消息、~228 MiB 正文**；重叠 109 个里 108 个取转录、1 个取老库（pi 时代 `019fef5f`）；他人 4 行按 owner 跳过。
- **合并证据**：59 个两边都有的会话里 55 个行数相等、3 个转录更全（跨迁移继续跑的会话，老库快照冻结在 10-01）、1 个老库更全（`019fef5f`，pi 时代会话，老库 3 行 vs 转录 1 行）。
- **保真度边界**：实时镜像在落库前跑 `normalizeFunctionalRefs`（`data:` URI 与工作区绝对路径链接改写为工作区相对链接）与 UNKNOWN_TOOL 候选附注；转录存的是**改写前原文**。重建时对正文重跑 `normalizeFunctionalRefs`（workspace 根取转录头 `cwd`）即可复原链接改写；UNKNOWN_TOOL 的候选附注不可复原（保留原始错误文本）。
- **镜像入口现状**：`server/agent-session.js:491/552`（本地回合）与 `cron-runner.js`（定时任务）都经 `chatHistory.recordMessage()`；`dsh-events.js` 的 `assistant/message` / `tool/call` / `tool/result` 分支累积 `ctx.dshTurnBlocks`。重建工具不 import 运行时，而是**复制同一套规则**——差异风险由对拍测试（fixture + 活库 dry-run）兜住。

## Goals / Non-Goals

**Goals:**

- 一条可复用、可复跑、默认安全（dry-run + 写前备份）的重建通道，把"索引被删/损坏"从数据损失降级为一次运维动作。
- 规则与实时镜像**逐字节同构**，且该同构有自动化测试钉死（合成 fixture + 生产活库对拍）。
- 本次把小说 cell 恢复成"被删前的样子"（125 行、含空会话与跨迁移会话的更全一侧）。

**Non-Goals:**

- 不改实时镜像路径（写入端零改动）。
- 不重建 `trace_events`（那是 bound-trace-storage 的域；且旧 trace 已随 8GB 库消亡）。
- 不做启动自愈（不在 `migrate.js` 挂重建；索引重建是显式运维动作，见 Decisions）。
- 不导入子代理会话、不导入他人（aloadtree）会话行——转录留在盘上不动。
- 不做通用"任意 cell 一键恢复"的运维平台化（工具支持 `--cell-root` 参数即止）。

## Decisions

### D1: 规则来源 = 复制镜像语义，而非复用运行时函数

`recordMessage` 的写入路径耦合 live 上下文（`sm`、`dshBridge`、`ctx.turnOrigin`），离线工具无法调用。选择在 `scripts/rebuild-chat-index.mjs` 内实现纯函数 `transcriptToRows(jsonlText, { workspaceRoot })`，与 `dsh-events.js` 的规则一一对应；**替代**（重构出共享模块供两侧 import）被否：会把重建这个低频工具塞进热路径的依赖图，且 dsh 事件形状随上游 rc 漂移，共享模块会把两侧的演进锁在一起——对拍测试是更好的耦合方式。

### D2: 顶层才建行；scope 全收；合并逐会话取更全

与实时镜像一致（`delegationDepth == 0` 才入索引）。三个 scope 都收——`--app--`/`--data-workspace--` 是迁移前 cwd 的历史作用域，跳过会让 10-01 前的会话整体消失。合并**逐会话**取行数更多的一侧（**替代**：老库优先——被 3 个跨迁移会话的反例推翻；**替代**：转录优先——被 `019fef5f` 的反例推翻）。

### D3: 工具形态 = 仓库脚本，pod 内执行

`scripts/rebuild-chat-index.mjs`，参数：`--cell-root <dir>`（必填）、`--legacy <app.db>`（可选）、`--apply`（默认 dry-run）、`--report <path>`（可选 JSON 报告）。在平台 pod 内跑（node + better-sqlite3 + zstd 齐全；宿主 python3 没有 better-sqlite3）。**替代**（宿主一次性 python 脚本）被否：不可复用、不进 CI、且要手搓 blocks JSON 与 sqlite 写入的等价语义。**替代**（挂进 `migrate.js` 启动自愈）被否：重建 100+ 会话的解析不该拖慢每次启动；隐式重建会把"索引被删"变成静默事件，掩盖真问题。

### D4: 安全闸 = dry-run 默认 + 写前备份 + 幂等 upsert + 停 cell 前置

写库前把 `app.db`（含 `-wal`/`-shm`）拷到 `app.db.bak-<ISO 时间戳>`；行写入用 `INSERT ... ON CONFLICT(id) DO UPDATE`（与 `upsertSession` 同形）；消息按 `seq` 连续写。**执行前必须停目标 cell**（单写者）——由 runbook 保证（网关会在下次请求时重新拉起）；工具在检测到 `-wal` 非空或 `app.db-shm` 存在时会警告（疑似进程仍持有库），但不停 cell 本身（工具不越权操作进程）。

### D5: 归属规则 = 只导本 cell owner；空会话照导

老库行按 `owner` 列过滤：等于 cell 的 `owner-groups.json` email 才导；他人行跳过（本次为 aloadtree 的 4 行）。**替代**（按 owner 原样导入）被否：那会把跨用户行永久留在该用户库里，而侧边栏按 owner 过滤，对本人毫无价值。空 "New chat"（0 消息）照导——恢复的是被删前的原状。

### D6: 保真度边界显式声明

重跑 `normalizeFunctionalRefs`（复用 `artifact-normalize.js` 导出）复原链接改写；UNKNOWN_TOOL 候选附注不复原（保留原始错误文本）。两者写进工具的 `--report` 输出与 spec 场景，不做静默近似。

## Risks / Trade-offs

- **[规则漂移]** dsh 上游改事件形状（约每日一个 rc）→ 工具静默产出错误行。缓解：`--report` 输出逐会话的解析统计（事件计数、未识别事件类型集合、跳过原因）；对拍测试在 CI 用合成 fixture 钉死当前形状；生产对拍（platform-test dry-run）在 runbook 里作为每次重建的前置。
- **[双写者]** 忘记停 cell 就 `--apply` → 与在线镜像并发写同一 WAL 库。缓解：工具检测 shm/wal 并警告；runbook 明确停 cell 步骤；重建前用 `--apply` 的 dry-run 先看报告。
- **[老库快照过期]** `--legacy` 库冻结在 10-01，若不跑合并、只按转录重建，会丢 16 个仅老库会话（13 空 + 3 有内容）。缓解：runbook 固定带 `--legacy`；工具报告里单列 "legacy-only" 计数，为 0 时提示可能漏传。
- **[体积预期]** 本次重建 ~228 MiB 正文（对比被删的 8GB 库，其中 trace 占 7.5GB）——重建后库显著变小是**预期行为**，不是数据丢失；报告里给出逐项字节数便于核对。
- **[时间戳来源]** 老库行保留其原时间戳；转录行用事件 `time`（毫秒）——跨迁移会话两段时间戳可能不严格单调，`seq` 序保证消息顺序。

## Migration Plan

1. **前置**：`fix-cell-spawn-inflight-dedup` 先上线（否则孤儿 cell 进程会与新库并发写）；滚动更新后确认目标 cell 只剩一个进程。
2. **停 cell**：在 cheap-3 上停 `2b043ce050ca134c` 的 cell 进程（网关下次请求自动拉起；如需完全静默可临时把该用户流量错开）。
3. **Dry-run**：pod 内 `node /app/scripts/rebuild-chat-index.mjs --cell-root /data/cells/2b043ce050ca134c --legacy /data/legacy/app.db`（legacy 库从 `/opt/platform/data/app.db` 拷入 pod 可达路径），核对报告：125 会话（109 转录侧 + 16 legacy-only）/ 5,104 消息 / 他人行 4 跳过 / 无解析错误。
4. **Apply**：加 `--apply` 执行；工具自动备份为 `app.db.bak-<ts>`。
5. **验收**：见 tasks 4.x（侧边栏 125 行、三个时代抽查、最大会话、交付链接、platform-test 对拍）。
6. **回滚**：还原备份 `app.db.bak-<ts>`（连同 `-wal`/`-shm` 一并还原或删除）→ 重启 cell。转录从未被修改，任何失败都可重来。

## Open Questions

（无——执行窗口与验收点已在前置 grill 定案。）
