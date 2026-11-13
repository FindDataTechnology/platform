# 设计：add-browser-use-lane

## Context

- **可对标板块缺口**：zcode/codex/hermes 类工具都有 browser use；壹座没有。
  官方 dsh `browser-use` 家族实证存在且活跃（seam `dsh-browser-use` +
  playwright-mcp/chrome-devtools-mcp/stagehand-native 三家 provider，
  npm `next` = 0.2.1-rc.4），但**钉死 0.2.1 线**——而 2026-10-27 spike 复核
  0.2.1-rc.4 合同仍 8/17 同签名（组合重写是有意的），等升级不现实。
- **稳定缝在手上**：`@deepseek-ai/dsh-mcp-client` 是 profile 插件层的既有通道，
  paas 的 `writeMcpPatch` + `requiresEnv` 省略语义（add-crm-desk-bridge D4：
  从不供给的死条目不骑在每个用户的 patch 上）已把「供给门」做成了一等词汇。
  Playwright MCP 直连不经 dsh 任何内部 API，跨代稳。
- **样例已躺两季**：`mcp.example.json` 的 playwright 条目（headless）从未扶正；
  上游官方 provider 就是包同一台服务器（`@playwright/mcp@0.0.80` 钉版）。
- **sidecar 共享是既有事实**（合同⑭钉住：3 agent 1 sidecar 进程）——per-cell
  共享浏览器不是新语义，是把事实显性化。
- **拓扑两形态**：云 cell 无头容器（chromium 要进镜像）；桌面 Electron 有形机
  （能开真窗，但安装包不背 ~170MB 起步的浏览器体积是既有发行纪律）。

## Goals / Non-Goals

**Goals:**
- 云 cell 上浏览器车道开箱即用（镜像背 runtime），工具出现在每个会话。
- 供给门三种部署形态（local / remote / absent+off）语义清晰、日志可观。
- per-cell 共享浏览器状态入 spec（登录态留存=特性，跨 cell 零泄漏）。
- 为 A2 官方 bundle 同位替换留好接口（条目名/工具族稳定语义）。

**Non-Goals:**
- 官方 browser-use seam / provider（0.2.1 移植后的事，挂 `port-dsh-0.2.1`）。
- 浏览器可视化面板（官方 sidebar-browser 是 dsh-web-app 件，壹座自建另立）。
- computer-use（云端沙箱桌面 / 桌面真机注入，双深坑）。
- 桌面端默认预装（v1 仅文档化 opt-in）。

## Decisions

### D1：A1 直连而非等官方 provider

官方 provider 的价值 = seam 独占语义 + 每会话所有权 + 官方演进。代价 = 钉死
0.2.1。判断：能力空缺等不起一次组合层移植；MCP 直连喂同一家上游服务器
（`@playwright/mcp`），工具族一致，A2 落地时以 plugin-supply 白名单同位替换
`platform.bundle.json` 条目，会话无感。**备选**：直接自研 provider 实现 seam
——投入最大且无对冲，弃。

### D2：供给门 = 文件系统 + 远程端点 + 显式关，复用省略语义

`writeMcpPatch` 在 requiresEnv 省略族上扩「文件系统供给」闸：
`BROWSER_RUNTIME_PATH`（镜像写入）存在 → local；否则 `BROWSER_CDP_ENDPOINT`
→ remote；否则（或 `BROWSER_LANE=off`）→ 整条省略 + info 日志。判定在
patch 生成期（cell 每 profile 一次），不做运行时探活。**备选**：条目常驻 +
调用期报错（websearch 族形态）——工具永远在场但永远失败是坏信号，弃；
省略 = 工具清单诚实（模型看不到不存在的腿）。

### D3：launch 参数面收敛

v1 固定 headless + 默认隔离档位；暴露的旋钮只有供给三态。每会话隔离上下文
（isolated contexts）查询 @playwright/mcp 旗标后二期（sidecar 是进程级单实例，
隔离做不到 per-session 浏览器——per-cell 语义已足够，见 D4）。

### D4：per-cell 共享入 spec，跨 cell 隔离靠拓扑

cell 内登录态跨会话留存是产品特性（用户视角：我的 cell 里的浏览器「记得」
我做过的登录）；跨 cell 天然各进程各目录。这与「MCP 凭据进程级共享」台账
教训同族——写进 spec 防日后被当 bug 回修。

### D5：镜像层放在 npm 层后、prune/冒烟同评审

Dockerfile 在依赖层之后加一行浏览器层（`npx playwright@<pin> install chromium
--with-deps` 或等价 runtime 拷贝 + `BROWSER_RUNTIME_PATH` 环境注入同一 RUN）；
体积 +~150MB 入台账口径；镜像冒烟加「headless launch + 例域导航」一条。
剪枝证据链不动（浏览器不走矩阵树）。

### D6：桌面 v1 只文档化 opt-in

dmg/exe 不背浏览器体积（发行纪律）；`mcp.example.json` 样例扶正成「取消注释 +
`npx playwright install chromium` 先行」的说明块。桌面形态的可视窗
（headless=false + 用户旁观）是产品化二期候选，与官方 sidebar-browser 思路同族。

## Risks / Trade-offs

- **镜像体积/构建时长**：+~150MB 与一层网络下载；GHA 构建通道额度口径
  （AGENTS.md fd-build-channel 纪律）——入任务核对额度。
- **`@playwright/mcp` 版本漂移**：钉版（0.0.80 同族）+ 升级走依赖轮次；
  工具面变化由 tool-use 渲染链自然承受。
- **远程端点信任**：CDP 端点 = 完整浏览器控制面；`.env.example` 注明只指向
  自有/可信端点，绝不代填。
- **与 A2 的接口漂移**：官方 bundle 落地时 seam 工具族可能与
  `mcp__playwright__*` 同名或不同名——替换任务含「工具引用点普查」
  （skills/fleet 提示词内的字面值），本 change 在 docs 留口径。
- **cell 内多会话并发操作同一浏览器**：串行由 MCP 服务器自身承受；
  交错的观感性侧写（两个会话看到对方开的标签页）属 D4 语义，二期可加
  isolated context 评估。
