# 提案：add-browser-use-lane —— 浏览器操作车道（A1：Playwright MCP 直连）

## Why

壹座 agent 没有浏览器操作能力——对标 zcode / codex / hermes 一类工具，browser
use 已是同类软件的固有板块。官方 dsh `browser-use` 家族（seam + 三家 provider）
钉死 dsh 0.2.1 线，而 0.2.1 跟随被合同判死两次（2026-10-27 spike 复核：
rc.4 仍 8/17 同签名），等它不现实。但 `dsh-mcp-client` 这层缝是稳定的：
Playwright MCP 直连**不依赖 dsh 版本**，`mcp.example.json` 里样例已躺了两个
季度没扶正。本 change 把这条车道做成一等公民（A1），官方 bundle（A2）随
`port-dsh-0.2.1` + `add-dsh-plugin-supply` 落地后同位替换。

## What Changes

- **预装浏览器车道**：`platform.bundle.json` 的 `mcpServers` 新增 `playwright`
  条目（origin bundled + locked，`@playwright/mcp` 官方服务器，版本钉 = 上游官方
  provider 同款 0.0.80 同族），headless 默认。
- **文件系统供给门**：chromium 运行时缺席且未配置远程端点时，整条车道在
  patch 生成期省略（requiresEnv 省略语义的同族扩展——「从不供给的死条目
  不骑在每个用户的 patch 上」，静默正常态）；配置 `BROWSER_CDP_ENDPOINT`
  时改走远程浏览器（attach 语义）。
- **cell 镜像烘焙 chromium**：Dockerfile 增浏览器层（`playwright install
  chromium` 等价物 + 运行时路径环境），镜像冒烟扩一条「browser lane 可启动」。
- **桌面端 v1 文档化 opt-in**：安装包不背 ~170MB chromium；`mcp.example.json`
  样例扶正为带启用说明的注释块。
- **会话真相入 spec**：浏览器状态 per-cell 共享（MCP sidecar 进程级共享的显性化
  ——同一 cell 内登录态跨会话留存是特性不是意外）。
- **工具面零前端改动**：`mcp__playwright__*` 走既有 tool_start/update/end 翻译链
  与 tool-use 渲染。

## Capabilities

### New Capabilities
- `browser-use`: 浏览器操作车道——预装供给、供给门（本地 chromium / 远程端点 /
  显式关闭）、per-cell 共享浏览器状态语义、缺席降级与可观性。

### Modified Capabilities
（无——grep 主 spec 无供给门/共享 sidecar 语义的既有 requirement 需改；
`extension-runtime-management` 的 bundled 条目通用行为已覆盖清单呈现。）

## Impact

- `platform.bundle.json` / `mcp.example.json`：车道条目与文档样例。
- `dsh-profile.js`：`writeMcpPatch` 供给门扩展（文件系统/远程端点二种缺席形态）。
- `Dockerfile`：chromium 层 + 冒烟；镜像体积 +~150MB 量级（入台账口径）。
- `docs/`（DEPLOY.md 车道开关与远程端点、AGENTS.md 运维口径、台账）。
- `e2e/` + 镜像冒烟：导航/截图真操作验证。
- **不影响**：既有 MCP 面语义、会话隔离边界（per-cell 内共享本就如此）、
  模型/预设选择；无 BREAKING。
- **挂账**：A2 官方 bundle 替换（`port-dsh-0.2.1` 落地后经 plugin-supply 供给）、
  浏览器可视化面板（sidebar-browser 官方是 dsh-web-app 件，壹座需自建）、
  computer-use（云端沙箱桌面 / 桌面真机权限链，双深坑，明确不做）。
