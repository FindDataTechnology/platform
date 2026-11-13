# 任务：add-browser-use-lane

## 1. 车道条目与供给门

- [x] 1.1 `platform.bundle.json` 增 `playwright` 条目（`bundled+locked` 口径，`laneGate: "browser"` 供给门标记；first-party 薄启动器 `server/browser-mcp.js` 拉起钉版 `@playwright/mcp`——与上游官方 provider 同款 0.0.80，headless 默认、`BROWSER_CDP_ENDPOINT` 时 attach）；`mcp.example.json` 样例扶正为桌面 opt-in 说明块（全局安装 + `BROWSER_MCP_CLI` 两步）
- [x] 1.2 `dsh-profile.js` `writeMcpPatch` 供给门：`BROWSER_RUNTIME_PATH`（目录真实存在）→ local、`BROWSER_CDP_ENDPOINT` → remote、`BROWSER_LANE=off` 或双缺席 → 整条省略 + info 日志（requiresEnv 省略族同族语义与日志格式；端点缺席永不回落本地启动）
- [x] 1.3 供给门形状测试 `scripts/test-browser-lane-gate.mjs`（node --test，5/5 绿）：absent/local/remote/off/失效路径 五形态各自的 patch 形状 + 省略即无文件/无条目

## 2. 镜像与部署

- [x] 2.1 Dockerfile 浏览器层（`/opt/browser-mcp` 独立前缀，纪律同 `/opt/harness-acp`——不进 dsh 矩阵版本面；`@playwright/mcp@0.0.80` + `playwright install --with-deps chromium`；镜像层 ENV 预置 `BROWSER_MCP_CLI`/`BROWSER_RUNTIME_PATH`/`PLAYWRIGHT_BROWSERS_PATH` 三旋钮）
- [x] 2.2 镜像冒烟：`.github/workflows/image.yml` 增「browser lane — MCP handshake」步（`scripts/browser-lane-smoke.mjs`：拉起 launcher→MCP initialize→tools/list 非空，本地实测 24 tools 通过；chromium 真启动属运营实证不在 CI 冒烟——CI 不发外网浏览器流量）
- [x] 2.3 `.env.example` 增浏览器车道段（三旋钮 + 信任警告 + 桌面 opt-in 两步）；DEPLOY.md 增「Browser lane」节（三形态、共享真相、follow-ups=A2 官方 bundle 替换/浏览器面板/computer use 挂账）

## 3. 能力实证

- [x] 3.1 供给/缺席/远程三形态的本地实证：供给门单测 5 形态 + 缺席形态真机 boot（`~/.dsh` profile 的 `mcp.patch.yml` 零 `mcp-playwright` 条目=工具面诚实缺席）；本地 `@playwright/mcp` 下 MCP 握手 + tools/list 24 工具真链
- [x] 3.2 滚产实证（sha-c4d0ce9，2026-10-28）：**agent 回合级全链真机**——pack 聚焦 cell 内 agent 实调 `mcp__playwright__browser_navigate` 读得标题 `Example Domain`、`browser_take_screenshot` 产物落 `/data/cells/<hash>/workspace/example_com_20261028.png`（71KB）且资源钩 `invalid_path` 零；live patch 条目带 `BROWSER_OUTPUT_DIR=会话工作区`；`PACK_BASELINE_MCP=fleet,playwright` 已放行 pack 人格使用车道。**已补验（2026-10-28 晚，台账 §15.70 续2）**：桌面 opt-in —— 复核逮出文档与供给门不一致（只设 `BROWSER_MCP_CLI` 不被认作供给）→ 门已拓宽（运行时目录 | `BROWSER_CHROMIUM_PATH` | CLI 文件，单测 7/7）+ 桌面形态本地实跑组出 lane、agent 实调 navigate+take_screenshot 得 79KB 真 PNG 落工作区 + 安装包确认不含 runner；跨 cell 零泄漏 —— 双隔离实例 A/B 对拍：A 关样包后 A 变 `[dsh-base]`、B 仍 `enabled=true`、共享树指纹 `5042a1c9…` 前后一致（A 已复原）
- [x] 3.3 per-cell 共享浏览器状态语义已入 spec（MCP sidecar 进程级共享=合同⑭既有事实的显性化；登录态跨会话留存=特性；跨 cell 隔离=结构保证）

## 4. 文档与收口

- [x] 4.1 CLAUDE.md 车道段 + DEPLOY.md 运维段；台账 `registry-maintenance` 条目随发布 commit 补记（镜像体积 +170-250MB、@playwright/mcp 0.0.80 钉版、独立前缀纪律）
- [x] 4.2 桌面 opt-in 文档（`mcp.example.json` 注释块 + `.env.example`）；可视窗/浏览器面板挂账（官方 sidebar-browser 是 dsh-web-app 件，壹座需自建）
- [x] 4.3 A2 替换预案挂账：port-dsh-0.2.1 落地后官方 bundle 经 plugin-supply 白名单同位替换 A1 条目（同工具语义）；本 change 的 DEPLOY/CLAUDE 段已写明该交接
