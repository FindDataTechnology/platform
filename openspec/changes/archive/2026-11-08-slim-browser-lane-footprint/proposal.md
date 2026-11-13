## Why

platform pod 实测 **3102Mi / 4Gi 上限（76%）**，而其中约 **640MB 是浏览器车道的纯闲置开销**：4 个 cell 各背一套 stdio 垫片（`server/browser-mcp.js` ~50MB）+ Playwright MCP（`@playwright/mcp` 109-131MB），而整个 pod 内**没有一个 chromium 进程**——此刻没有任何 cell 在跑浏览器回合。浏览器是唯一"不承载回合、却按 cell 复制"的子进程；把它的计费单位从 cell 改成 pod，是当前最便宜的内存回收点，且完全不碰 dsh 版本与 cell 生命周期语义。

## What Changes

- **新增 pod 级共享浏览器服务**：一个 `@playwright/mcp` 进程（SSE）+ 一个 chromium，按 pod 部署一份；cell 侧不再各自 spawn 浏览器子进程。
- **新增一层薄协议前端**：dsh 的 MCP 客户端只支持 `stdio` / `streamable-http`，而 playwright MCP 的 `--port` 只提供 SSE——两者不能直连，服务需要一个把 streamable-http 会话转成 SSE 客户端会话的前端进程。该前端同时承担 cell 身份识别（决定每会话的产物目录）。
- **每个 cell 一个独立 browser context**：沿用 playwright MCP 的默认语义（每个 HTTP 会话独立上下文，`--shared-browser-context` 明确**不**开启）——进程共用，登录态/标签页/凭据不跨 cell。
- **产物路由按 cell 分流**：共享服务只有一个 `--output-dir`，原先是每 cell 注入会话 workspace。前端按 cell 身份把该会话的产物写进该 cell 可读的子目录，`/api/files` 的可见性语义不变。
- **cell 侧垫片退役**：`dsh-profile.js` 在提供共享端点时改为写 `{transport: "streamable-http", url}` 的 MCP 条目，不再写 stdio 命令 → 每 cell 省掉垫片与 MCP 两个进程。
- **BREAKING（内部语义）**：`browser-use` 现行要求「每个 cell 各自驱动独立浏览器**进程**」改为「每个 cell 独立浏览器**上下文**」，共享一个 pod 级进程。供应门（local/remote/absent、`BROWSER_LANE=off`）三态语义保持不变。
- **失败域显式化**：共享服务不可用时，各 cell 的浏览器工具按既有 MCP 降级语义变灰并记录原因；不回落到 cell 内本地拉起（避免"看起来共享、实际又长出 N 份"）。

## Capabilities

### New Capabilities

- `browser-lane-service`: pod 级共享浏览器服务——端点与供应、每会话（cell）上下文隔离、产物按 cell 分流、单点失败时的显式降级。

### Modified Capabilities

- `browser-use`: 「Each cell owns one shared browser state」由"每 cell 一个浏览器进程"改为"每 cell 一个浏览器上下文"，允许 pod 级共享进程；local/remote/absent 供应门与降级语义不变。

## Impact

- **代码**：`dsh-profile.js`（supply gate 与 MCP 条目组装，见 1006-1060 行的 browser lane 分支与 `toMcpClientEntry`）、`server/browser-mcp.js`（垫片退出线上路径，保留为无共享端点时的回退形态）、新增服务前端与其部署单元。
- **部署**：platform pod 增加一个 sidecar（或同 pod 容器）与两个 env（共享端点、产物根）；agent-runner 侧若供应浏览器运行时，同样改为连本 pod 的前端。
- **契约**：`browser-use` 的隔离要求改写（进程 → 上下文）；供应门与 `BROWSER_LANE=off` 的既有 Scenario 全部保持。
- **观测**：内存面孔新增共享服务的 footprint 行；cell 侧不再出现 browser 子进程，健康面应以"服务可达"表达该车道状态。
- **风险面**：共享进程成为跨 cell 的单点——崩溃影响全部 cell 的浏览器能力（不崩溃其他工具）；凭据/登录态的隔离改由上下文边界承担，需要哨兵测试证明不串。
