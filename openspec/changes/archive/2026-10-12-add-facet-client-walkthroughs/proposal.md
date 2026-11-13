## Why

F2.1（`docs/facet-market-roadmap.md`）：机制已建（F1 三片：CLI 五 target、MCP 双路、
`#/docs`），本片补**实证与背书**——五客户端「从零到装好」真环境 walkthrough，验证
技能安装与 MCP 写入路径，实证内容回填深度文档。质量线：真环境录证，不接受文档想象。

## What Changes

- **真环境 walkthrough（本机 macOS，五 target 逐个）**：`facet connect`（真 wgk 键，
  platformtest 身份经 registry console 铸）→ `facet install <公开 pack> --target X
  --write-mcp` → 验证技能落位（<dotdir>/skills/SKILL.md）+ 原生 MCP 配置形状
  （~/.claude.json mcpServers / ~/.cursor/mcp.json / ~/.zcode/cli/config.json
  mcp.servers / ~/.gemini/settings.json mcpServers / ~/.codex/config.toml
  [mcp_servers.*]）+ HTTP initialize 探针（键+端点即任何客户端将走的握手）。
- **发现并修复真缺口**：CLI 设备流 client_id `facet-cli` 未在 Logto 注册——device
  授权起点 400。本片核实并按需处理（文档诚实记录现状+可行路径，或 Logto 应用注册
  若可经现有凭据完成）。
- **实证内容回填** `docs/ecosystem/{claude-code,cursor,zcode,codex,gemini-cli}.md`：
  每家补「实证记录」节（命令实录、落位文件、配置片段、initialize 结果、已知边界如
  cursor 无本机二进制=配置面实证）。
- OSS 快照推送（深度文档公开面）；facet 壳 `#/docs` 若引用文案变化则随滚。

## Impact

- 代码：零或极小（若 CLI 需小修）；主要是 docs/ecosystem/*.md 实证内容。
- specs：facet-platform 增补 walkthrough 实证需求。
- 产物：wgk 键一枚（platformtest 名下 facet-cli-walkthrough）+ 本机五 target 真实
  安装（技能+MCP 配置——产品正常运行态，非测试残留）。
