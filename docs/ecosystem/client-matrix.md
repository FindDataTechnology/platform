# 客户端支持矩阵

五家编辑器/CLI 客户端在谦面（facet）上的能力一览。**每一格都有出处**：要么是 CLI 的
代码事实（`facet/cli/facet.js` 的 `SKILLS_SUBDIR`/`MCP_TARGETS`——CLI 写什么），要么是
真环境 walkthrough 的实证（客户端认什么，见各客户端指南的「实证记录」节）——没有
想象格。定期冒烟（`scripts/smoke-facet-clients.mjs`）持续验证 CLI 侧写入形状。

| 能力 | claude-code | cursor | zcode | codex | gemini-cli |
|---|---|---|---|---|---|
| 技能安装 · 用户级 | ✅ `~/.claude/skills/` | ✅ `~/.cursor/skills/` | ✅ `~/.zcode/skills/` | ✅ `~/.codex/skills/` | ✅ `~/.gemini/skills/` |
| 技能安装 · 项目级 | ✅ `<dir>/.claude/skills/` | ✅ `<dir>/.cursor/skills/` | ✅ `<dir>/.zcode/skills/` | ✅ `<dir>/.codex/skills/` | ✅ `<dir>/.gemini/skills/` |
| MCP 配置写 · 用户级 | ✅ `~/.claude.json`（`type:"http"`） | ✅ `~/.cursor/mcp.json` | ✅ `~/.zcode/cli/config.json`（`mcp.servers`） | ✅ `~/.codex/config.toml`（`[mcp_servers.*]`） | ✅ `~/.gemini/settings.json`（`httpUrl`） |
| MCP 配置写 · 项目级 | ✅ `<dir>/.mcp.json` | ✅ `<dir>/.cursor/mcp.json` | —（无项目级 MCP 约定） | —（同左） | —（同左） |
| 插件市场形态 | ✅ `/plugin marketplace add` | — | — | — | — |
| 更新路径 | `facet update`（快照重取，报 v旧→v新） | 同左 | 同左 | 同左 | 同左 |
| 真环境实证（2026-10-12） | ✅ 全链（技能+配置+wire initialize 200） | ◐ 配置面（目标机无 Cursor 二进制） | ✅ 全链 | ✅ 配置面+wire 探针 | ✅ 配置面+wire 探针 |

## 口径说明

- **「技能安装」**=facet CLI 把 `SKILL.md` 写进该客户端的技能目录；**项目级**用
  `--project <dir>`。客户端是否主动读取该目录随其版本而异（Cursor 的技能目录支持
  已知随版本变化，可将内容接入 `.cursor/rules/`）——CLI 写入形状是稳定承诺，客户端
  读取面见各指南实证节。
- **「MCP 配置写」**=持 wgk- 键后 `install --write-mcp` 代写该客户端的原生连接配置；
  条目形状逐字节见矩阵单元格。连通性另需该 server 在注册处健康/启用且键所属组可见
  （停用=405、组不可见=401，诚实边界详见各指南）。
- **「更新路径」**=`facet update`（v0.2.2+）：按本地安装记录重取最新版快照，无订阅
  副作用。
- **真环境实证**三档：✅ 全链（含 wire initialize）/ ◐ 配置面 / —（未实证）。

出处：[claude-code](claude-code.md) · [cursor](cursor.md) · [zcode](zcode.md) ·
[codex](codex.md) · [gemini-cli](gemini-cli.md) 各指南的「实证记录」节；
CLI 代码事实由冒烟脚本持续咬合。
