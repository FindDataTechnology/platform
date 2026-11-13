## Context

动机见 proposal.md。这里只列塑造方案的事实。

### 实测（2026-11-08，fd-prod，platform pod）

| 组成 | 每 cell | ×4 cell |
|---|---|---|
| `server.js`（平台服务） | 220–289MB | ~1.0GB |
| dsh child | 140–207MB | ~0.7GB |
| `server/browser-mcp.js`（stdio 垫片） | 49–52MB | ~200MB |
| `@playwright/mcp/cli.js` | 109–131MB | ~450MB |
| gateway + fleet-mcp | — | ~200MB |
| **合计** | | **3102Mi / 4Gi** |

- pod 内 `chromium`/`headless_shell` 进程数 = **0**：浏览器车道此刻完全闲置，仍付 ~640MB。
- cell 生命周期已是一个健康机制：32 个 cell 中 **29 个 suspended**，`CELL_IDLE_REAP_SECS=3600`，实测唤醒 ~8.6–12 秒。把内存押在"让 cell 多睡"上没有空间——睡着的本来就不占。
- agent-runner 侧与本题无关：serving runner 已 `AGENT_RUNNER_POD_MODE=1`，20 agent 只用 4 个进程。

### 协议事实（决定了必须有一层前端）

- dsh 的 `dsh-mcp-client` 只接受 `transport: 'stdio' | 'streamable-http'`——0.2.0-rc.2 与 0.2.2-rc.1 两棵树逐字相同。
- `@playwright/mcp` 的 `--port` 只提供 **SSE**（本镜像钉 0.0.80；npm 最新 0.0.84 文档仍写 SSE）。
- 结论：cell 不能直接 `url` 指向 playwright MCP。共享需要一个把 streamable-http 会话翻译成 SSE 客户端会话的前端。

### 现有接线（将被改动的位置）

- `dsh-profile.js:1006-1060`：browser lane 供应门（`laneGate: "browser"`，local/remote/absent 三态）与每会话 `BROWSER_OUTPUT_DIR` 注入。
- `dsh-profile.js:686-760`：`toMcpClientEntry` 同时支持 `command`(stdio) 与 `url`(streamable-http) 两种条目形态——共享端点走后者，不需要新形态。
- `server/browser-mcp.js`：stdio 垫片，"exec the PINNED `@playwright/mcp` CLI so the lane's version and flags are deployment facts"。

## Goals / Non-Goals

**Goals:**
- 浏览器车道的常驻开销从「每 cell 一套」变成「每 pod 一套」，目标 platform pod 3102Mi → ≤2.5GB。
- 保留每 cell 的浏览器状态隔离（登录态、标签页、凭据不跨 cell）。
- 保留现有供应门语义与"不可用时工具根本不出现/显式降级"的两种形态。
- 无共享端点时行为与本变更前**逐字节相同**（桌面端、单机、agent-runner 单机形态）。

**Non-Goals:**
- 不动 cell 生命周期、不降 `CELL_IDLE_REAP_SECS`（实测无收益、有冷启代价）。
- 不合并 cell 的 dsh child（回合收尾进程级串行，属另一条 change）。
- 不跨 pod/跨节点共享浏览器（失败放大 + 网络域，见 D1）。
- 不改 playwright MCP 版本或 fork 它。

## Decisions

### D1. 共享粒度 = pod，不是 cluster

cell 与 platform pod 同生命周期：pod 滚版本时全部 cell 一起重启。共享体放在 pod 内，故障域与现有 pod 一致，不引入跨节点调用。

*备选*：cluster 级单实例——省得更多（pod 再多也只一份），但把"一个 pod 挂"升级成"全站浏览器车道挂"，且要认证与网络域。否决。

### D2. 加一层薄协议前端，而不是让 cell 直连 SSE

前端 = 一个 streamable-http MCP 服务端 + 一个 SSE MCP 客户端（官方 SDK 两侧都有），每接入一个 cell 会话就开一条到 playwright MCP 的 SSE 会话。

*备选*
- **改 cell 侧垫片直连共享服务**：垫片仍按 cell 存在（-50MB×N 变成 -0），正是要消灭的形态。否决。
- **等上游支持 streamable-http**：0.0.84 未支持，被动跟随不可控。否决。
- **保留 stdio，多垫片连同一 chromium（`--cdp-endpoint`）**：只省 chromium，而当前 chromium 数为 0（省不到），且 MCP 进程仍 N 份。否决。

### D3. 隔离语义 = 每会话独立 browser context

playwright MCP 在 `--port` 模式下的默认行为是"每个 HTTP 客户端各自一个 browser context"，`--shared-browser-context` 才是共用。我们明确**不**开它。

这样进程共用一个、浏览器共用一份，而 cookie/登录态/标签页按 cell 分开——正是"共用进程、不混上下文"。

*代价*：`browser-use` 现行 spec 写的是"每 cell 各自驱动独立浏览器**进程**"，需改写为"独立**上下文**"。这是本变更唯一的 spec 级破坏。

**裁决（2026-11-08）**：隔离粒度为**每会话**，登录态只在一次会话内保持；同一 cell 的
新会话从干净上下文开始（`--isolated`，profile 不落盘）。原「同一 cell 跨会话保持登录」
场景已随之改写为「同一会话内持久 + 新会话干净」，理由：共享进程的 profile 一旦落盘，
就多出一份跨 cell 可读的磁盘状态，正是本变更要削掉的形态。

### D4. 产物路由由前端按 cell 身份分流

共享服务只有一个 `--output-dir`，而现状是每会话注入该 cell 的 workspace（`/api/files` 与资源捕获都依赖它）。

前端知道自己代的是哪个 cell（连接时带 cell 身份），因此在 `tools/call` 转发时把 `filename` 参数前缀改写为该 cell 的子目录（绝对路径），未被指名的自动命名产物同样落进该目录。

*备选*：靠模型行为（工具描述 overlay 要求"文件名带 cell 前缀"）——不可验证，作为辅助提示可以，作为主路径否决。
*备选*：共享写一个大池子、按所有者猜归属——归属不可判定，且泄漏面不可控。否决。

### D5. 没有共享端点时保留现有 stdio 路径

`BROWSER_SHARED_MCP_URL` 未设置 → `dsh-profile.js` 继续写 stdio 条目、继续 spawn 垫片。桌面端与单机形态的字节行为不变，是本变更的回滚面。

### D6. 共享服务挂了不回落本地拉起

服务不可达时，cell 的浏览器工具按既有 MCP 降级语义变灰并记录原因（`failOnStartupError: false` 的既有路径），**不**在 cell 内拉起本地 playwright——否则故障时会静默长出 N 份，正是本变更要消灭的形态。

## Risks / Trade-offs

- **[跨 cell 上下文串] → 哨兵测试**：两个 cell 同时登录不同站点、断言互相看不到对方的 cookie/登录态；另断言 `--shared-browser-context` 在部署配置里没有出现。
- **[单点失败扩大] → 显式降级 + 重启策略**：前端与 playwright 各自有重启策略与健康面；pod 内其它工具不受影响；日志点名"browser lane unavailable at shared endpoint"。
- **[协议前端保真度] → 用官方 SDK 两端，覆盖长操作与取消**：`tools/call`、长导航、取消、流式进度；抓"SSE 事件丢失/取消不生效"。
- **[产物路径变更破 `/api/files`] → 契约测试**：截图与下载的可见性、资源捕获都按 cell 目录断言。
- **[cell 身份伪造] → 前端只认进程内来源**：cell 到前端走 pod 内回环；标识由前端从连接方上下文取，不由客户端自报。
- **[内存集中但 CPU 争用]**：4 个 cell 同时跑浏览器会争一份 chromium 的 CPU。浏览器是低频车道，接受；若成为问题，后续可加"每 pod 最大并发上下文数"（见 Open Questions）。

## Migration Plan

1. 新增共享服务单元（前端 + playwright MCP + chromium），随 platform pod 部署，先不接线（只有端点可用）。
2. `dsh-profile.js` 增加 `BROWSER_SHARED_MCP_URL` 分支；灰度 = 先给一个测试 cell 设置，观测工具面、产物、降级三项。
3. 全量打开后观测 platform pod footprint（目标 ≤2.5GB）与 cell 进程表（应无 browser 子进程）。
4. 回滚 = 删除该 env，下一次 patch 写入即回到每 cell 自家进程；无需回滚镜像。

## Open Questions

- 每 pod 最大并发 browser context 数：当前数据不足以定值（浏览器回合是低频），先不限，留一条观测指标。
- 是否需要把该前端同时用于 agent-runner 侧的浏览器供应：取决于 runner 是否供应浏览器运行时，接线点已预留（同一个 env）。
