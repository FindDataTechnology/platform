# Proposal: rebuild-chat-index

## Why

2026-10-09 深夜 cheap-3 冻死清障时，小说用户 cell（`2b043ce050ca134c`）的会话索引库 `data/data/app.db` 被整体删除——它已涨到 8GB（其中约 7.5GB 是 `trace_events`，会话证据只有零头），磁盘清障只能删。会话索引（`chat_sessions` / `chat_messages`）是**侧边栏与历史回放的唯一来源**，删掉后该用户登录只看到空列表，1546 个会话、476MB 原始对话在盘上却不可见。

被删的库无法找回（无备份、无进程持有句柄），但**内容没丢**：dsh 运行时的逐会话转录 `dsh/sessions/<scope>/<sessionId>/session.jsonl.zstd` 完整保留（含工具调用与结果），迁移时留在原地的单进程老库 `/opt/platform/data/app.db` 也意外成为 10-01 前的快照。本变更交付"从转录重建会话索引"的工具与流程，把索引的可重建性变成契约——**转录是事实源，SQLite 只是索引**。

## What Changes

- **新增重建工具 `scripts/rebuild-chat-index.mjs`**：读 cell 的 dsh 转录（多帧 zstd，逐帧解），按运行时镜像语义重建 `chat_sessions` / `chat_messages`。默认 dry-run（只报告），`--apply` 才写库；写库前自动备份现有 app.db。
- **镜像语义逐字节对齐**：消息与 blocks 的生成规则已在 platform-test cell 的活库上通过 14/14 逐字节对拍（见 design），工具必须复用同一规则——用户消息取 `agent/inbox/spliced` 与 `user/message` 中 `source.kind == "user"` 的事件（按事件 id 去重）、助手消息在 `assistant/message` 且（有 text 或有本轮工具块）时落一行、blocks 由本轮 `tool/call` + `tool/result` 合成（`arguments` 字符串 parse 成 `args`、结果正文取 tool-result 内层 text、`isError` 映射 `state`）。消息正文过一遍 `normalizeFunctionalRefs`（workspace 根取转录头 `cwd`）。
- **重建范围与合并规则**：顶层会话（`delegationDepth == 0`）才建行——与实时镜像一致（子代理会话从不入索引）；三个 scope 全收（`--app--`、`--data-workspace--`、当前 workspace）。重叠会话逐会话取**更全的一侧**（转录行数 ≥ 老库行数取转录，否则取老库）；仅老库有的会话照建（含空 "New chat"，恢复被删前的原状）；**不导入非本 cell 用户的会话行**（共享时代物理遗留在该 cell 的他人会话转录保持原样、不建行）。
- **迁移搬运选项 `--legacy <path>`**：可指到迁移前的老库（如 `/opt/platform/data/app.db`），按上述规则参与合并；不指定则纯转录重建。
- **运行前置与幂等**：执行前必须停掉目标 cell（保证单写者）；工具对已存在的会话行做 upsert（幂等，可重跑）。
- **契约化**：`chat-history` spec 增补"会话索引可从转录重建"要求；`turn-tracing` 不受影响。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `chat-history`: 新增一条要求——会话索引 SHALL 可由 dsh 转录重建（工具存在、dry-run 默认、写前备份、与实时镜像同构），并 SHALL 保持"转录是事实源、索引是可重建投影"的语义。

## Impact

- **新增**：`scripts/rebuild-chat-index.mjs`（可复用、可入库）、其单测 `scripts/test-rebuild-chat-index.mjs`（合成 fixture 逐字节对拍）。
- **改动**：`openspec/specs/chat-history/spec.md`（经本 change 归档）。
- **数据**：一次生产运维动作——cheap-3 上 `2b043ce050ca134c` 的会话索引重建（实测 dry-run：125 个会话、5,104 条消息、~228 MiB）；不影响其他 cell。
- **不改**：实时镜像路径（`chat-history.js` / `dsh-events.js`）、WS 协议、前端。
- **依赖**：工具在平台镜像内运行（pod 里 node + better-sqlite3 + zstd 齐全，`inspect-live-session.mjs` 已有先例）。
