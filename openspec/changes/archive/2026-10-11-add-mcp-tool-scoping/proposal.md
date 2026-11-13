# Proposal: add-mcp-tool-scoping

## Why

Pack 对 MCP 的引用粒度是整个 server：挂载即把该 server 全部工具注册进模型上下文（fd-daas-mcp 161 个、fd-open-data-mcp 71 个）。只需要几个工具的 pack 背负整面工具 schema——上下文 token 与弱模型的工具选择质量双双受损；而 registry 虚拟 MCP 的绕法覆盖不了用户自部署的 MCP（不经过网关）。工具过滤本质是客户端关注点，dsh 已有积木（`ctx.tools.restrict()/guard()`、persona 组装钩子），现在把它们接起来。

## What Changes

- **声明层（manifest）**：`mcpServers[].allowTools`（工具叶名白名单，精确名、无通配符、每 server ≤64）；`agents[].resources.mcpTools`（per-role 再收窄，⊆ pack 级声明）。
- **发布校验（publish）**：声明的叶名对拍 registry `tool_list` 快照，未知名 fail；快照缺失时实时探测一次 `tools/list` 兜底；对已上牌 server（surface meta 在册），声明 ⊆ commercial 集否则 fail。
- **安装与本地绑定**：非 registry 名的引用绑定到同名本地（用户自部署）行——安装报告新增 `bound`（本地行已存在）/ `awaiting-local-binding`（待用户装同名 server，不是失败）两状态；本地名免组门；绑定不写 `extension_configs`、不覆盖用户配置。
- **运行时执行（focused 模式）**：资源集增加工具维度——角色只见 allowlist 内工具。独立桥 `platform-mcp-tool-filter` 执行：`guard()` 硬拦未声明调用（理由可读、永不 throw、抗漂移）+ `restrict()` 尽力收窄上下文（遇未知名捕获降级为仅 guard）。配置由 host 侧从 `deriveScope` 物化，桥零 DB 依赖。
- **向后兼容**：无 `allowTools` = 全量（存量 pack 零影响）；未声明 `resources.mcpTools` 的角色 = pack 级声明。
- **上游对齐**：桥的配置形状对齐拟提的 `dsh-mcp-client` `allowedTools` 字段（filter-at-registration）；上游落地后迁移点收敛在 patch 生成处。issue 文案起草入 design.md 附录。
- **明确不做**：registry 虚拟 MCP 不动（保留产品级 SKU 面定位）；用户级「设置→MCP 工具裁剪」UI 与自建预设工具维度排 v1.x（执行层挂点本期一次做全，声明面后续开放）。

## Capabilities

### New Capabilities

（无——行为变化全部落在三个既有能力上）

### Modified Capabilities

- `pack-authoring`: manifest 内容模型增加工具白名单声明（pack 级 `allowTools`、per-role `resources.mcpTools`，收窄方向单向）；publish 冻结版本前做工具名校验（未知名 fail + 实时探测兜底；已上牌 server 越 commercial 集即 fail）。
- `pack-installation`: MCP 引用允许绑定同名本地 server 行——`bound` / `awaiting-local-binding` 报告状态（非失败、不阻塞整包安装），本地名免组门，绑定记录随 pack 版本快照走。
- `pack-agent-scoping`: 聚焦资源集增加工具维度——被保留 server 只有 allowlist 内工具对角色可见/可调；未声明调用以可读理由拒绝；漂移只降级上下文收窄（尽力），不降级拦截（硬性）。

## Impact

- `lib/pack-manifest.js` — 校验器新键 `allowTools`/`resources.mcpTools`、`PACK_LIMITS.maxToolsPerMcp`
- `pack-store.js` — `installMcpRef` 本地绑定两状态；`preset-pack-bridge.js` / `dsh-profile.js` `deriveScope` — scope 增 `mcpTools` 维度
- `dsh-profile-template/` — 新桥 `platform-mcp-tool-filter`（guard+restrict，配置物化自 host 侧）
- `facet/`（publish 端）— 工具名校验 + registry `tool_list`/surface meta 读取 + 实时探测兜底
- `registry-bridge.js` — `mapServer` 携带 `tool_list` 至市场 catalog
- `web/` — pack 编辑器工具白名单编辑面 + 安装报告新状态渲染
- `agent-runner/compose.js` — 经共享 profile 管线自然继承（壹座 web/桌面/萬星 runner 三面同覆盖）
- 跨仓：finddata `mcp-surface-contract` 需一条 delta（消费侧 commercial 闭合要求落地）——**独立 change，本 proposal 定稿后立**
- 无 dsh 上游依赖（纯桥实现）；上游 `allowedTools` 若落地，替换点收敛在 patch 生成处
