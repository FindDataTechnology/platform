# Design: add-mcp-tool-scoping

## Context

工具过滤是客户端关注点：上下文膨胀发生在 dsh 会话内，registry 侧的任何机制（虚拟 MCP 条目、快照）都到不了用户自部署的 server。dsh 运行时已具备执行积木——`ctx.tools.restrict({allow,deny})`（per-agent 作用域、精确名、未知名 throw）、`ctx.tools.guard(cb)`（调用期硬闸、抗漂移）、以及我们自己的组装钩子 `platform-preset-bridge` 的 `setup(agentCtx)`（`presets.mount` 之后可对 agentCtx 施加任何作用域操作）。web cell、桌面、萬星 runner 三面共用 `dsh-profile.js` 的 patch 合成管线（`agent-runner/compose.js` 同源），执行层落在这条管线即全覆盖。

dsh-mcp-client 至 0.2.1-alpha.2 无过滤面（已核）；上游 `allowedTools` 是语义上最正确的位置（filter-at-registration），本设计以桥为可迁移替身。

## Goals / Non-Goals

**Goals**
- 一条执行链同时覆盖 pack persona / 自建预设（后续）/ 用户裁剪（后续）三个声明入口
- 拦截硬性、收窄尽力：任何漂移下越权调用不可达，收窄失败只退化为「看得见但调不动」
- 上游 `allowedTools` 落地时替换点收敛在 patch 生成处一处

**Non-Goals**
- registry 虚拟 MCP / mcpgw fork 改动（零）
- 用户级「设置→MCP 工具裁剪」UI、自建预设工具维度的声明面（v1.x；执行层挂点本期就绪）
- 通配符、deny 语义（v2 再议；deny 属用户裁剪语义）
- dsh 上游代码修改

## Decisions

### D1 执行层 = 独立桥 `platform-mcp-tool-filter`，配置由 host 侧物化

新 profile bridge 插件（`dsh-profile-template/` 家族，与 tool-search/preset-bridge 同构）。配置不在桥内查 DB：`dsh-profile.js` 在合成时从 `deriveScope` 推导出当前角色的 `{serverName → allowlist}` 映射，物化为静态配置写进 patch（`writeToolFilterPatch`，原子写、persona 切换即重写）。桥只读配置执行。

- 为什么不塞进 `platform-preset-bridge.setup`：声明推导全在 host 侧 `deriveScope`（单一事实源），桥沾 DB 会复制推导逻辑且 HMR 粒度粗；独立桥与现有桥家族纪律一致。
- 为什么不让桥自己调 `deriveScope`：cell 的 DB 对 dsh 子进程不可达（bridge 家族均按此边界设计）；配置物化让桥零依赖、可单测。

### D2 拦截 = `guard()` 硬闸（安全底线），收窄 = `restrict()` 尽力 + 降级

- **guard 先装**：`setup(agentCtx)` 时 `agentCtx.tools.guard()` 拒绝一切 `mcp__<server>__<leaf>` 中 leaf ∉ allowlist 的调用，理由文案可读（点名工具+聚焦范围+建议切换模式）。guard 按「服务器前缀匹配 + 名单成员判断」实现，不依赖工具是否已注册——**永不 throw**，这是抗漂移的硬保证（spec：interception hard）。
- **restrict 后补**：MCP 工具是异步同步的（连接完成才有名字），而 `restrict()` 对未知名 throw 且需 agent 作用域。桥监听工具注册表事件（"A tool was registered or unregistered, or a scoped restriction changed"），当映射中任一 server 的工具已注册后，对该 server 计算 `deny = 已注册叶名 − allowlist` 施加 `restrict({deny})`；throw（快照/注册竞态）即捕获降级——只留 guard，下次事件重试。deny 而非 allow：allow 在漂移（server 删工具）时必 throw，deny 只对「实际存在且未声明」的名字生效，新工具由 guard 兜住。
- **拒绝理由**：guard 返回文案与「聚焦角色诚实回答」既有规范一致（pack-agent-scoping「Role explains instead of hallucinating」）。

### D3 manifest 形状 = 扁平 `allowTools`，只白名单

`mcpServers[i].allowTools: string[]`（叶名，`[A-Za-z0-9._-]{1,128}`，≤64/server，`PACK_LIMITS.maxToolsPerMcp`）；`agents[].resources.mcpTools: { "<registryName>": string[] }`（⊆ pack 级声明，校验器拒绝放宽）。禁 `url/command/...` 的 v1 边界不动——`allowTools` 是纯名字声明。校验器新增键合法化（`MCP_FORBIDDEN_KEYS` 不涉及）；resources 维度键集合从 `{skills, mcpServers}` 扩为三键。

### D4 安装 = 绑定记录进 pack 安装态，不写 extension_configs

`installMcpRef` 解析顺序：registry catalog 命中 → 现行安装路径（allowlist 随行）；未命中 → 查本地 `getMcpServer(name)`：存在即 `bound`（只在 installed-pack 记录里记绑定名+allowlist），不存在即 `awaiting-local-binding`（同样不失败）。本地名跳过组门与市场凭据检查（本地行自带配置与凭据）。focus 组装（`deriveScope`）把绑定名并入 `mcpKeep` 语义——同名命中已装集即生效，后续本地安装同名 server 后无需重装（compose-time 相交，天然成立）。

### D5 publish 校验 = 快照对拍 + 实时探测兜底 + surface 闭合

facet 发布端（`facet/`）在既有 manifest 校验后加两道门：
1. **存在性**：registry `/api/servers` 条目的 `tool_list` 快照对拍；缺失名 → 对该 server 的网关代理路径发一次 MCP `initialize + tools/list` 实时探测（facet 服务端可达，registry-bridge 已有同源探活逻辑）；探到即放行（快照滞后），否则 fail。探测有界（单 server 单次、超时 ~5s），受既有发布限流约束。
2. **commercial 闭合**：条目带 surface meta（已上牌）时，声明 ⊆ commercial 集 else fail——此项与探测结果无关（internal 工具存在也不可进 pack）。
- 本地（非 registry）引用免两道门（server 面不可知，声明即契约）。
- 市场目录侧：`registry-bridge.mapServer` 携带 `tool_list`（及 surface commercial 集若在）进 catalog，编辑器工具选择器直接吃它。
- 快照口径缺陷已知（台账 business-mcp 24/9 事故）——探测兜底正是为此设计。

### D6 组装 = deriveScope 增 `mcpTools` 维度，与 mcpKeep 同法推导

`deriveScope` 从 installed-pack 版本快照 + persona 声明 + overlay 推导 `mcpTools: {server: Set(leaf)}`：pack 级 allowList ∩（role 声明若有）→ 存入 scope；`writeToolFilterPatch` 据此写桥配置。overlay（add/removeMcp）是 server 级偏好，v1 不加工具级 overlay（用户裁剪 v1.x 再开口——届时同一配置面）。焦点裁剪掉整个 server 时其 allowlist 自然随行失效。

## Risks / Trade-offs

- [restrict 时序舞步复杂（事件等待/重试/deny 计算）] → 桥的收窄路径完全可降级：guard 独立成立，restrict 失败只影响上下文经济不影响安全；e2e 以 roster 断言收窄、以调用断言拦截，两条互不依赖
- [guard 拒绝发生在模型已看到工具的会话（收窄未及时）] → 短暂窗口内模型可能尝试被拒工具、收到可读理由后自纠；窗口只存在于启动竞态，稳定态 roster 已收窄
- [快照滞后误伤 publish] → D5 实时探测兜底；探测也失败（server 下线）时 fail 是正确行为（声明的工具确实不可验证）
- [本地绑定的名字撞上 registry 后来的新条目] → 解析顺序 registry 优先；已 bound 的本地绑定保持（安装态是快照语义，升级时重新解析）
- [161 工具 server 的 allowlist 校验成本] → 名单比对是集合操作，publish 限流（10/hr/作者）下无感知
- [桥对 guard/restrict API 的 dsh 版本耦合] → 桥走 `@deepseek-ai/dsh-tools` 公共面（与 tool-search 桥同依赖），rc 跟随既有矩阵纪律

## Migration Plan

1. 校验器 + deriveScope + 桥 + patch 物化（无行为变化直到 manifest 带 allowTools）——存量 pack 全量语义，零迁移
2. publish 两道门上线（facet）+ catalog 携带 tool_list
3. 编辑器工具选择器 + 安装报告新状态渲染
4. 回滚：桥配置为空映射即等价无桥；任何一层可独立 revert，installed-pack 记录新增字段向后兼容（旧版读到未知字段忽略）

## Open Questions

- ~~registry `/api/servers` 列表响应是否已含 `tool_list`~~ **已答（实现期）**：响应形状 `{servers: [...]}`，条目携带 `tool_list`（mapServer 已消费）与 `metadata.surface`——surface 当前只有计数形状（`tools_commercial: 18` 无名单表），闭合门按 `metadata.surface.commercial_tools` 名单表生效、计数形状跳过并留观测 note。**名单表 enrichment（上牌时把 commercial 工具名写进 metadata.surface）挂 finddata 侧 change 任务。**
- guard 理由文案的中英双语形态（现有 guard 文案先例需对齐）→ tasks 期定（现为单语英文一行，与既有 bridge 文案一致；验收 7.1 断言「可读」不锁语言）
