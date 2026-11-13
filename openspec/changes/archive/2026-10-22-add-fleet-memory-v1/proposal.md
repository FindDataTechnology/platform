## Why

上百 agents 长期运行需要跨会话的工作记忆：萬星 runner 上的部署 agent 今天每会话从零开始，任务状态、交接（handoff）与沉淀事实无处安放；多 harness 底线（dsh/ACP 双线）已完结，记忆面是终局缺的两块新面之一。切片 1（mem-pilot-local，2026-10-19）已验证 stock ai-memory 的 handoff 协议跨 harness 可用（dsh 写、ZCode 认领续作），并拿到三条决定性实证：**dsh=MCP-only 零 observations（manager 代采是必然）**、token 注入面分 stdio-bridge/http-直连两档、ai-memory 单租户设计不能当舰队服务器——自建舰队记忆服务从偏好变为必然。调研底稿与试点报告：`docs/memory-and-stats-plane-explore.md`、`docs/memory-pilot-local-report.md`。

## What Changes

- **新仓 `fd-memory`（finddata 侧，TS/Node 22）**：舰队级一等记忆服务。OKF 兼容存储（markdown wiki 真源 + SQLite FTS5 派生索引，格式对齐 ai-memory 上游、可互操作）；双 namespace `u/<user>/p/<project>`（人）与 `d/<packId>/<agentId>`（部署），**跨 owner 永不共库**（物理隔离的 store root）；零 LLM（无 embeddings、无生成式摘要，v1 只有规则衰减位预留）。
- **MCP 面（streamable-http，带鉴权）**：v1 工具裁剪自试点实证的 23 工具面——handoff 四件套（begin/accept/cancel/list，claim-once）+ query/recent + read_page/write_page。
- **capture API（HTTP POST）**：hooks 形状事件（session-start/user-prompt-submit/pre+post-tool-use/stop/session-end），供 runner manager 代采与本地节点（`.ai-memory.toml` `server=` 路由）投递。
- **令牌两族**：部署令牌（绑定单个 `d/` namespace，最小权限）与人令牌（绑定 `u/`）；v1 由 admin CLI 铸造，Logto 自助铸造与部署时自动铸造为后续任务。
- **paas runner 侧**：manager 在既有回合事件缝上代采（deployment token 投递 capture API，不进 adapter 契约）；部署的 MCP 组合自动注入 fd-memory 条目（dsh 走 mcp.patch、ACP 走 session/new mcpServers，token 解析与既有凭据纪律同源）；persona 记忆纪律文案（dsh preset persona 后缀 + ACP CLAUDE.md 追加段）。
- **非目标**：不做 LLM 摘要/嵌入/蒸馏（L2 远期）；不做团队共享 namespace（v2）；不动壹座 cell 侧挂载与本地联邦（切片 4）；不做统计面（切片 3 并行）；sub2api/计费不涉。

## Capabilities

### New Capabilities

- `fleet-memory`: 舰队记忆服务的契约——namespace 与隔离纪律、令牌两族与鉴权边界、MCP 工具面（handoff claim-once）、capture API 事件形状、OKF 兼容存储与派生索引可重建、零 LLM 边界、优雅降级（服务不可用不阻断回合）。

### Modified Capabilities

- `agent-runner`: 新增要求——部署 agent 的回合观测经平台缝代采进舰队记忆（manager 侧、带部署令牌、与 usage 事件同缝）；部署组合自动携带记忆 MCP 挂载与 persona 记忆纪律；记忆面不可用时回合照常（降级开放、如实记录）。

## Impact

- **新仓**：`~/finddata/fd-memory`（舰队服务族，与 registry/sub2api 并列；服务本体 + admin CLI + 单测）。
- **paas 代码**：`agent-runner/manager.js`（代采客户端）、`agent-runner/compose.js`/`compose-acp.js`（记忆 MCP 注入）、`agent-runner/` persona 纪律文案、心跳自报（memory 可用性，可选）。runner 镜像重出（出片走 fd-build-channel 判路，GHA→TCR 链，纪律照旧）。
- **基础设施**：fd-memory 服务上舰队（k8s 单实例起步 + 备份；具体落点设计定）。无新外部依赖（SQLite/markdown/git 均内置或现成）。
- **验收基线**：切片 1 实证复演——生产 runner 上一个部署 agent 跨会话 handoff 接力成功；manager 代采产生 observations（dsh 与 ACP 各一）；服务停机时回合不受影响；跨 owner 访问被拒（401/403）。
