# Design: add-preset-to-pack-bridge

## Context

预设面与创作面各自成型（openspec: custom-presets、pack-authoring），中间没有桥。转换所需的判据已在库里：`custom_skills.origin_pack_id` 区分用户自有技能与 pack 物化技能；`extension_configs.origin === "registry"` 标记市场安装的 MCP；`registry-bridge` 维护市场快照（`getMarketEntries()`）；草稿存储复用 `pack_drafts`（`db.createDraft`）。见 proposal.md - Why。

## Goals / Non-Goals

Goals: 服务端一次性转换 + 可迁移性解析 + 标注报告；预设与草稿保持零关联。

Non-Goals: 报告在草稿上持久化（响应即弃）；资源集声明预填（预设无此维度）；批量/反向同步（proposal Non-goals 已列）。

## Decisions

**D1 — 单端点、服务端解析、复用草稿存储**: `POST /api/agent/presets/:id/pack-draft`（custom-presets 路由族），内部组装 entries 后调 `db.createDraft`——与编辑器建草稿同一存储路径，无新表无客户端拼装。可迁移性是平台判断（spec 要求），客户端只呈现报告。转换成功返回 `{ draft, report }`；预设本体不读改。

**D2 — 技能迁移判据 = `origin_pack_id`**: 为 NULL（用户自有）→ 以 `custom_skills` 行的 name/description/content 内联为草稿技能条目；非 NULL（pack 物化）→ 不携带，报告标注待替换并点名所属 pack。预设的技能宇宙本就不含仓库基线 skills/（presetView 只读 `listCustomSkills()`），无基线分支。

**D3 — MCP 迁移判据 = 市场目录按名解析（registry 来源）**: 引用名在 mcp.json 运维层 → 待替换；不在已启用扩展中 → 待替换（unavailable）；在扩展中且 `findMarketMcpEntry(name)` 命中 `origin === "registry"` 的市场条目 → 存为该 registryName 引用；命中不了 → 待替换（local，无论从未有过还是已消失）。判据以**市场目录**为准而非扩展行的 origin 列——实现期 e2e 抓到：没有任何代码路径会写 `origin: "registry"`（pack 安装与手工录入都落 "user"），扩展行 origin 不可作判据；市场目录按名解析正是 pack 安装自己的准入判据（installMcpRef），同源。解析前调 `refreshRegistry()` 一次（single-flight，失败沿用 last-good 快照，报告如实反映快照内容）。

**D4 — 预填形状**: 草稿 name = 预设名；单个 agent 条目带 name/persona/tags/icon 原样 + `serving: { protocol: "a2a" }` 预置（作者可摘）；不预填 resources 声明（缺省 = 整包集合）。预设字段上限本就镜像 pack 上限（custom-presets LIMITS 注释），无截断风险。

**D5 — 门槛对齐，不开旁门**: 端点执行与 `POST /api/pack-drafts` 相同的 manage gate（建草稿与手写草稿同权），门不过则 403 且不留任何半成品状态。预设侧权限不变。

**D6 — 报告即响应、编辑器呈现一次**: `report = { inlinedSkills: [], mcpServers: [], pendingSkills: [{ name, pack }], pendingServers: [] }` 仅随响应走；web 侧 CustomPresetsPage 行动作「转为功能集草稿」→ 成功后带报告跳转 pack 编辑器打开新草稿，待替换清单在编辑器顶部横幅呈现一次。草稿本身不知自己来自转换。

## Risks / Trade-offs

- [市场快照陈旧 → 误标待替换] → 转换前强制 refresh（D3）；即便误标也只是多一步手工补录，无损。
- [无 manage 权限的预设用户被门槛挡住] → 明确 403 文案指路（去创作面）；这是既有权限模型的如实传递，不在本片放宽。
- [pack 技能内容被整段内联的版权边界] → 判据从源头杜绝：非自有一律不携带（D2），报告只点名不取文。

## Migration Plan

纯增量：新路由 + web 动作，无 schema 变更、无数据迁移。回滚 = 移除路由与按钮，草稿与预设数据不受影响。

## Open Questions

- 市场安装扩展与市场条目的精确对应键（扩展名 vs config 内携带的 registry 引用）在实现时核对 `extensions.js` 安装流——不改变 D3 的判据结构，只可能换匹配键。
