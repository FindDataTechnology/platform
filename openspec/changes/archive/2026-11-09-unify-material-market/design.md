## Context

见 `proposal.md`。实现约束与前例：

- 市场页已经是注册表驱动：`packages/core/src/lib/surfaces.ts` 的 `AGENTS_TAB_SURFACES` 经 `resolveLayout()` 收窄，页面按解析结果渲染页签。所以"加页签"是注册表改动，不是新路由体系。
- MCP / 技能的**视图组件已存在且带容器参数**：`ExtensionsPage({ type: "mcp" | "skills" })`，现在由设置弹窗按 slug 挂载（两个 slug 开两个子视图）。搬容器不影响其内部（已装/商店/外链区/候选审核）。
- 插件的读面已存在：`PluginsSection` 用 WS `list_plugins` 取 `pluginBundles` / `pluginsAvailable`，开关走 plugin-supply 桥；`dsh-plugin-supply` 明确"构建期供应、运行时不装代码"。
- 素材目录已存在：`facet/supply-catalog.js` 的 `SUPPLY_SPECIES` + `SUPPLY_SPECIES_VERSION`（当前 5 / v1），`/api/supply-catalog/species` 暴露版本。
- 审校已有 runbook 与台账：`docs/ecosystem-curation.md`、`docs/ecosystem-curation-ledger.md`（S1–S7 / Q1–Q5 轴，首批白名单）。

## Goals / Non-Goals

**Goals**：用户在一个前场页面里看见并处置四类能力（智能体/工具/技能/插件）；设置只剩配置（模型在内）；插件有"看见全部 → 申请 → 被供应 → 启用"的闭环；物种枚举按既有规矩升版本。

**Non-Goals**：不做运行时安装（C 方案）；不改插件运行时加载方式；不重做 MCP/技能的安装与凭据流程；不动 pack 的发布/订阅契约；不改公开素材广场站点。

## Decisions

### D1 一个页面五个页签，slug 不动

`/agents` 的 slug 不变（公开契约），标签改 **素材市场**；`AGENTS_TAB_SURFACES` 由 `market|mine` 扩为 `agents|tools|skills|plugins|mine`。旧值 `market`/`supply`/`apps`/`build` 走 aliases（`SURFACE_SLUG_ALIASES` 已有一处归一表，扩它）。

- 为什么不动 slug：`layout-configuration` 的 R1「slug 是公开 API」；改名要先付一轮别名+重定向，收益只是"名字更准"。而 `fleet` 已有先例（slug 不变、标签改）。
- 替代（否）：新增 `/market` 并让 `/agents` 重定向——会把 pack 的三个既有深链（`deployCastPack`、`?tab=market`、收藏）各多一跳，且要再改一次 `pack-marketplace`/`agent-catalog` 的路由句。

### D2 设置退场两节，模型留

设置成员 12 → 10：`mcp`、`plugins` 走**路由级重定向**（不是 alias，因为弹窗绝不能为它们打开）：`/settings/mcp` → `/agents?tab=tools`，`/settings/skills` → `?tab=skills`，`/settings/plugins` → `?tab=plugins`。

- 为什么 `models` 留：模型是**配置**（选哪个、key 在哪），不是"获取能力"；用户原话也是这个分界。
- 替代（否）：把模型也搬前场——会稀释"市场"语义，且模型页有 provider 增删改的破坏性操作，属设置。

### D3 插件页签 = 目录全量 + 三态

行状态由**供应态**派生，不由客户端猜：

| 状态 | 判定 | 可用动作 |
|---|---|---|
| `可启用` | 本部署已烘入、当前未启用 | 启用开关 |
| `已启用` | 已烘入且启用 | 停用开关 |
| `未供应` | 目录有、本部署没烘 | 申请供应（**不渲染**禁用开关） |

- 为什么不留"灰开关"：灰开关暗示"本可以点"，而真实答案是"这份部署里没有它"——用户会去查网络/权限。给正确的动作。
- 目录为空也要给解释态（"本部署未随附任何插件"），不能白屏。

### D4 申请供应 = 记录 + 派生状态，永不安装

`plugin-supply-request` 只写一行申请（插件 id、目录版本、申请人、时间、四态），读时状态由"当前供应态"派生：被供应后自动显示 `supplied`，不做手工回写。

- 为什么这样能成立：出片是本方控制的（内部维护、无外部客户），延迟一次出片可接受；而"运行时装代码"会推翻平台的安全承诺。C 方案单独立单。
- 替代（否）：申请直接触发一次构建——把用户动作接到 CI 上，爆炸半径不可控。

### D5 物种枚举 v1 → v2

`SUPPLY_SPECIES` 追加 `plugin`，`SUPPLY_SPECIES_VERSION = 2`；插件条目沿用注解形状，另加 `reviewedAt/reviewer/licence` 三个**本物种专属**字段（不污染其他物种的词表）。

- 为什么先升版本再加字段：`supply-catalog` 明文规定"新物种扩展枚举并升版本，不得重载既有值"。这次是该规则的第一次真实行使，正好验证它可执行。

## Risks / Trade-offs

- [页签变多，240px 侧栏 + 5 页签] → 页签在内容区顶部而非侧栏，宽度不是问题；但窄视口要允许横向滚动。
- [MCP/技能搬出设置后，老用户找不到] → `/settings/mcp`、`/settings/skills`、`/settings/plugins` 三条重定向 + 构建家族仍指到市场页；再加一条一次性提示（可选）。
- [插件目录与真实的 image 烘入清单不一致] → 状态必须由服务端供应态派生，客户端不得维护第二份；e2e 要有一条"目录有、供应无 → 未供应"的反证。
- [申请洪水] → 幂等 + 按插件按部署去重；rate limit 沿用现有 abuse 控制思路。
- [改 `agent-catalog` 的子页签契约] → 一次性改到位；旧值全部别名化，`e2e/agents-tabs` 与新市场 spec 同时覆盖。

## Migration Plan

1. 注册表（`surfaces.ts`）+ 预设 + aliases，先让页签存在、旧值归一到 `agents` tab。
2. `AgentMarketPage` 变五页签壳，`tools`/`skills` 复用 `ExtensionsPage` 的视图组件（拆出可独立挂载的子组件）；`plugins` 接 `PluginsSection` 的读面并加三态。
3. 设置退场两节 + 三条重定向。
4. 服务端：`SUPPLY_SPECIES` v2、插件目录读面、申请流水与状态派生。
5. 文档：`docs/ecosystem-curation.md` 增插件审校轴与条目模板；台账加首批候选。
6. e2e 全量更新 + 新市场 spec。

回滚：页签是注册表收窄，回滚注册表即回旧 IA（旧 slug 全在）；服务端新增路由只增不减，回滚前端不影响数据。

## Open Questions

- 首批插件候选清单（3–5 个）要等审校台账跑完才有，属于内容而非结构，不阻塞本 change 的结构落地。
