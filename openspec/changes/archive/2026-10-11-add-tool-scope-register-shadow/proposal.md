# Proposal: add-tool-scope-register-shadow

## Why

add-mcp-tool-scoping 的执行桥用两层收窄：guard（调用期硬拦）+ restrict（组合期掩码）。
两层都达成了**拦截**语义，但掩码语义有一个结构性缺口：restrict 只在会话组合时执行一次，
MCP 服务器中途 resync（cordis HMR 重挂 mcp.patch.yml、网络重连触发的新一代 tools/list）
注册的工具会**重新进入 roster**直到下一次组合——schema 上下文成本随之回来，而 161 工具级
服务器（fd-daas-mcp）的整个包上下文经济学正建立在这笔成本被拿掉的前提上。此外掩码后
的定义仍在注册表层，任何 registry introspection 面（tool_search 族）仍能看到并诱导模型
去调一个注定被 guard 拒绝的工具。

上游讨论 #9385（我们的 allowedTools 提案）的回帖给出并发布了 register-instance-shadow
接缝（`@argszero/dsh-mcp-tool-filter`）：在 mcp-client 注册之前，对 tools 服务实例的
`register` 方法做 own-property 影子包装，越权工具**根本不进注册表**——语义 1（never
registered）当天可达，无需上游改动。本仓已在生产 pin 的确切版本组合上实证该接缝
（dsh-tools 0.1.1-rc.2 + cordis 4.0.4，两轮探针 14/14 断言：view/全局注册均被拦截、
越权 leaf 不出现在 schemas()、非 MCP 工具直通、**receiver 保留 scope 归属**（scoped
注册不泄漏全局层）、清理可还原原型方法）。

## What Changes

- **执行桥加第三层 `installMcpToolRegisterShadow(ctx)`**（platform-tool-scope.js）：
  `Reflect.get(ctx.get('tools'), Symbol.for('cordis.original'))` 解原始 ToolRuntime，
  在实例上以 own property 影子化 `register`——MCP 形状且落映射服务器的越权 leaf 直接
  不注册（返回惰性 disposer），其余一律 `protoRegister.call(this, …)` 原样透传（receiver
  原样保留，scoped 注册归属不变）。过滤器每次注册时重读（与 guard 同一 HMR 纪律）；
  影子内部任何异常一律透传原方法——**性能不劣于现状**（最坏退回 guard+restrict 语义）。
  经 `ctx.effect` 安装，fiber dispose/HMR 时删除 own property 还原原型。
- **挂载点与顺序**：preset 桥 `apply()` 内、`installMcpToolGuard` 旁安装（插件启动期，
  早于 mcp-client 首代注册——runner 侧 compose.js 的 patchPaths 已是 presets 先于 mcp）。
  **web cell 补齐顺序**：dsh-bridge.js `patchArgs` 从 `mcp → presets` 调整为
  `presets → mcp`（与 runner 对齐；桥不依赖 mcp 行，tools 服务来自 base bundle——顺序
  对调安全），否则 web cell 上 mcp-client 首代注册先于桥启动、影子错过首代。
- **guard 与 restrict 原样保留**（纵深防御）：影子生效时 restrict 的 deny 集自然为空
  （近似 no-op）；影子错过首代或异常降级时，现有两层语义完整兜底。发布门/commercial
  surface/安装层三态绑定等其余 add-mcp-tool-scoping 资产零改动。
- **真 cordis 接缝测试**进仓（scripts/test-tool-scope-register-seam.mjs）：以仓库依赖
  的 @deepseek-ai/cordis + dsh-system-prompt + dsh-tools 起真实 Context，覆盖两轮探针
  的断言面（拦截/丢弃/直通/scope 归属/还原）——上游版本升级时该测试是接缝的活体哨兵。
- **上游回帖**（非本仓代码）：在 #9385 回帖报告我们在 0.1.1-rc.2 上的实证与接入方式，
  呼应 raw-leaf 匹配论点。

## Capabilities

- `mcp-tool-scoping`（既有 capability，MODIFIED）：执行桥从两层升三层，新增
  never-registered 语义场景（resync 不回涨、introspection 不可见、降级路径不劣于现状）。

## Impact

- 代码：dsh-profile-template/platform-tool-scope.js（+shadow ~50 行）、
  platform-preset-bridge.js（apply 一行）、dsh-bridge.js（patchArgs 顺序 + 注释）、
  scripts/test-tool-scope-bridge.mjs（stub 补充）、新增 scripts/test-tool-scope-register-seam.mjs。
- 兼容性：无 filter（全量模式/legacy 包）时影子为纯透传，行为逐字节等同现状；
  e2e 三件（聚焦收窄/兼容回归/漂移兜底）不改编。
- 部署：随平台镜像常规滚动（GHA→hkccr→relay→ccr 标准线），cell 重启后生效；
  dsh-profile.js 的桥拷贝管线（writeToolFilterPatch 无条件刷新）自动把新桥推进存量 profile。
