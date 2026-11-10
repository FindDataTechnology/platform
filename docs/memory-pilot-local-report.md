# 记忆面切片 1（mem-pilot-local）试点报告

> 2026-10-19 执行收口。上承 `docs/memory-and-stats-plane-explore.md` 切片 1 与三判据。
> **结论先行：三判据全过（判据① harness 由 CC↔ZCode 替换为 dsh↔ZCode，环境阻断如实记录），
> 切片 2（fleet-memory-v1 / fd-memory 新仓）可以立项。**

## 环境

- ai-memory **3.0.0**（brew tap `akitaonrails/tap`，Homebrew 7 需 `brew trust` 解锁公式加载，
  下载 sha256 校验仍由 brew 强制）；macOS arm64。
- server：loopback `127.0.0.1:49374`，HTTP transport；`embedding_provider = "none"`（判据②前置）；
  `capture_assistant` 保持默认关（双重 opt-in）。
- 数据目录 `~/Library/Application Support/ai-memory`：OKF 布局实证（workspace/project 目录、
  月度 ledger `log-2026-10.md`、`sessions/<id>.md` 会话页、`db/memory.sqlite` 派生索引）。

## 判据①：真实任务跨 harness 接力 — 通过（harness 替换）

**任务**：markdown 链接检查器两阶段（parseLinks 提取 → 递归扫描+锚点校验+死链输出），
产物仓 `~/pilot-ai-memory/linkcheck`。

**原定 CC↔ZCode 不可行，四 harness 环境阻断盘点**（本机 2026-10-19 实测）：

| harness | 阻断 | 性质 |
|---|---|---|
| Claude Code 2.1.294 | `ANTHROPIC_BASE_URL=127.0.0.1:15721` 本地 router 无主不在跑（全机无配置痕迹/launchctl/历史），无直连凭据 | 用户手工组件下线，需用户起 |
| Gemini CLI 0.41.2 | OAuth 有效但 `IneligibleTierError: UNSUPPORTED_CLIENT`——Google 停个人版 tier 逼迁 Antigravity | 不可逆 |
| Codex | vendored `codex-darwin-arm64` spawn 直接崩 + 无 auth.json | 安装损坏+未登录 |
| Qwen 0.14.4 | OAuth 过期，headless 起设备码流程无人可点 | 需人工浏览器授权 |

**实际路径：dsh 0.2.0-rc.2（headless）↔ ZCode**——比原计划更贴切片 2 的生产形态（runner 上跑的就是 dsh）：

- Phase A：dsh headless + 词元网关 **free 模型**（`cohere/north-mini-code:free`，零成本）跑第一阶段，
  经 MCP 工具 `mcp__ai-memory__memory_handoff_begin` 写出**结构化 handoff**（summary +
  5 open_questions + 5 next_steps + files_touched）；中途经历一次 compaction，被词元 502 打断退出
  （free 档不稳，如实记录）。
- Phase B（ZCode 侧，本 session）：经 ZCode node 内核手写 MCP 客户端连 `http://127.0.0.1:49374/mcp`
  → `memory_handoff_accept` **认领成功（`status: claimed`，claim-once 生效）** → 凭 brief 续作
  （**未重述任务背景**：入口即 files_touched + parseLinks 接口形状 + next_steps；其 open_questions
  由续作方以设计决策回答：外链跳过、仅本地校验、零依赖不 fetch）→ 交付第二阶段 +
  修正 Phase A 幻觉（自述「自测通过」但 test-extract.mjs 实际未落盘）→ **13 断言 ALL PASS +
  受控目录 e2e 正确报 4 死链、活链零误报**。
- **意外实证（判据①附赠）**：第一次 claude -p 尝试虽被 ECONNREFUSED 打断，但 CC 项目作用域 hooks
  全链存活——SessionEnd 自动 finalize 并生成 handoff（捕获管线在失败会话上仍完整）。
  **质量对比**：agent 自写 handoff（结构化、可直接续作）≫ 平台自动生成（仅原文焦点提取、无结构）
  ——Q11「agent 自写+平台触发」决策的活体证据。

## 判据②：敏感信息抽查 — 通过（附两起本会话泄露事故与处置）

- `wiki/` + `raw/` 文本面 grep 十类模式（sk-/ghp_/github_pat_/AKIA/PEM 私钥/Bearer/xoxb-/wgk-- 等）
  **零命中**；入库观测无敏感内容。
- **事故记录（纪律执行）**：本会话 transcript 两次印出真实 token——
  ① ai-memory 根 token（print 模式 MCP snippet 带出）；② codex `config.toml` 里 fd-daas-mcp 的
  `wgk--…` Bearer（自写脱敏正则没盖住 TOML 内联表）。处置：① 已轮换（generate-auth-token 重写
  auth-tokens/default + auth-token + auth-header）、四处字面量注册同步（zcode config.json、
  qwen settings.json；claude 与 gemini 实为 `mcp-bridge` stdio 形态**从文件读 token、无字面量**，
  自愈）、服务重启后 401/200 验证通过；② 属用户自有 registry 凭据，**建议用户择时轮换**
  （暴露面=本机会话日志）。
- 上游事实修正：v3.0.0 embeddings 默认＝**本地 MiniLM、零外发**（「embedding 发全文」仅 provider 档
  成立）——禁用纪律可按部署形态细化，不必一刀切。

## 判据③：ZCode 支持档位与限制 — 通过（全实测）

- **MCP**：注册进 `~/.zcode/cli/config.json` 的 `mcp.servers`（严格 schema：`type`/`url`/`headers`
  only，未知键静默丢弃服务）。因 schema 只能字面量 header，安装器**拒绝自动把 server token 抄进
  别家配置**，须 `AI_MEMORY_AUTH_TOKEN=… install-mcp --client zcode --apply` 显式授权——token 落在
  0644 的 config.json 里，单用户机+loopback 服务可接受，舰队形态应改走 per-deployment 短令牌。
- **hooks**：六事件全装（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Stop），
  **exec-form**（`type: process`、command+args、无 shell、10s timeout），注册在 `hooks.events`
  注册表（ZCode 专有层），与用户既有顶层旧格式 hooks 共存不冲突。
- **SessionStart stdout 注入**（handoff 递送通道）：上游已对 engine v0.16.5 实证可用。
- **边界**：`Stop`=回合边界、**无 SessionEnd** → 会话收尾须手动 `ai-memory finalize-session --agent zcode`。
- hooks 在本 session 启动后才装入 → 本 session 未被捕获（符合预期；新 ZCode session 起生效）。

## 新发现（切片 2 设计输入）

1. **dsh=MCP-only 的活体证据**：dsh 会话在记忆库里只有 handoff、**零 observations**（无 hooks）——
   「manager 代采」不是优化项而是必然（D4 决策实证）。runner 侧 capture 必须走 adapter/manager 缝。
2. **token 注入面两档**：stdio `mcp-bridge` 客户端（claude/gemini）从数据目录文件读 token（可轮换自愈）；
   http 直连客户端（zcode/qwen/droid/codex 等）必须字面量 header。舰队服务的令牌策略要按客户端形态分档。
3. **qwen 可骑 gemini 系集成**（fork 同 settings schema，MCP+hooks 已手工并入且结构校验通过），
   OAuth 过期未实跑——非原生支持 harness 的接入成本数据点。
4. **词元 free 模型档**跑 agent 任务可行但不稳（502 打断）——试点可用，生产勿用。
5. **headless dsh 组装配方**（可直接复用到切片 2 runner 侧）：profile 模板初始化
   （`dsh <name> --from-default-profile headless`）→ `cordis.patch.yml` 追加 `llm-pi-ai` 行
   （注意 `reasoningEfforts` 不接受空数组，无档位就不写）+ `agent-default-model` 行覆盖默认模型
   （出厂默认 deepseek-official 会要 DEEPSEEK_API_KEY）→ `.credentials.yaml`（version:1 + refs.LLM_API_KEY）
   → `mcp.patch.yml`（`- insert:` dsh-mcp-client loader 条目，streamable-http+headers）→ 启动必须
   **显式 `--patch <path>`**（launcher 不自动拾取 profile 目录内的 patch 文件，paas compose.js 同款做法）。
6. **handoff 协议实测**：list/accept/cancel 全通；accept 返回完整 handoff + `claimed`；被认领/取消后
   ledger 清空。MCP 工具面 23 个（handoff 四件套 + query/briefing/recent/consolidate/lint/forget_sweep/
   message 邮箱/auto_improve 等）——舰队记忆服务的 v1 工具面可 以此为基线裁剪。

## 试点遗留物与清理

| 物 | 位置 | 建议 |
|---|---|---|
| ai-memory server | 后台进程，loopback 49374 | 保留（狗粮节点）；开机自启可 `brew services start akitaonrails/tap/ai-memory` |
| ZCode hooks+MCP | `~/.zcode/cli/config.json`（安装器备份在册） | 保留——新 ZCode session 起开始捕获 |
| CC hooks（项目作用域） | `~/pilot-ai-memory/linkcheck/.claude/settings.local.json` | 随试点仓保留 |
| CC MCP（用户作用域） | `~/.claude.json` 顶层 mcpServers | 保留（loopback 无害）；CC 恢复代理后即用 |
| gemini/qwen 接线 | 各自 settings.json（备份在册） | 保留待其可驱动时验证 |
| dsh 试点 home | `~/pilot-ai-memory/dsh-home`（自含） | 保留（切片 2 配方参照） |
| 一键回滚 | `ai-memory uninstall --apply`（全部 harness 接线）+ `brew uninstall ai-memory` + 删数据目录 | — |

**下一步**：切片 2 `fleet-memory-v1`（fd-memory 新仓）按底稿立项；统计面切片 3 可并行开线。
