## Context

- 三条显示链互相不通：① MCP server 卡（`McpServerCard.tsx:81` 裸显 `server.name`，L99 连 command/args 原文都渲染）；② 工具名/描述全链上游原文直通（`dsh-mcp-client` runtime `tools/list` → `parseToolSchema` 原样透传 → `ToolBlock.tsx:127` mono 直显）；③ skill/pack 描述中只有 pack manifest `i18n` 覆盖块成熟（`lib/pack-manifest.js:498-700` 校验、`lib/pack-locale.js` 解析、gateway/packs `localizedSummary` 消费），但白名单 `LOCALE_OVERLAY_KEYS`（`pack-manifest.js:506`）不含 mcpServers。
- 注释可挂的现成锚点：registry `/api/servers` 行已有 `display_name`/`description` 与自由 `metadata{}`（facet mapper `registry-bridge.js:151-198` 在读）；壹座 `extension-store.js:143-190` 已有 market 目录×registry 快照合并点；仓库静态目录 `market-catalog.json` 已有 `displayName`/`description`（全英文）。
- facet 目录端点（`facet/mcp-catalog.js`）不带 locale；facet 前端有五语切换器但只翻 chrome。
- 消费方：`add-tool-description-enrichment`（change ③）吃 `canonical`；`add-agent-builder-hub` 供给区三柜渲染吃 human 轨。

## Goals / Non-Goals

**Goals**：注释数据契约一次定稿（human + canonical + provenance）；两展示面（壹座、facet）按 locale 投影；无注释逐字节不变。

**Non-Goals**：运行时 tool-face 注入（change ③）；注释在线编辑台（v1 经仓库目录/registry metadata 录入）；SKILL.md/persona 正文翻译（仍不在范围，本单只做显示层）；机翻管线。

## Decisions

### D1: 注释真源 = registry metadata 为主源，仓库目录为静态源，上游原文为兜底
注释块约定挂 registry 行 `metadata.annotations`（JSON 透传，registry 侧**零改码**）；bundled/离线供给挂 `market-catalog.json` 扩展形状；两源都无 → 上游原文。壹座合并点复用 `extension-store.js` 既有合并（只加字段不换机制）。
- **为什么**：registry 是壹座与 facet 的共同真源，metadata 自由 JSON 让外部服务改码归零；仓库目录保 offline/bundled 与 GitOps 可审计。
- **备选**：壹座侧新表存注释（拒：facet 读不到，两平面必然分叉）；改 registry 表结构（拒：跨服务改码，成本收益不成比例）。

### D2: 读时投影，写路径为零
投影发生在读面（extensions 读路由、facet mapper、规格书读面），源行/registry 条目/目录文件零写。注释编辑 = 改 registry metadata（既有 registry 管理面）或改仓库目录（走 GitOps PR）。
- **为什么**：与「市场为真源建制、读面投影」的既律同构；避免第二份可变状态。

### D3: canonical 形状在本单定稿、本单不消费
`canonical.brief: string`（可选字段）。change ③ 的注入行为（替换 vs 追加、gate、开关）全部在那单的 spec/design 里，本单只保证形状稳定。
- **为什么**：数据形状早定防 ③ 回炉；行为晚定让 ③ 的风险隔离在自己单内。

### D4: zh 主轨纪律与存量英文目录的一次策展
注释 `human.zh` 必填（未填整条拒）；现 `market-catalog.json` 英文 `displayName/description` 迁为 en 副轨、新写 zh 主轨（一次性策展，10 个 server 体量可控）；五语言里 ja/es/fr 可选渐进。
- **为什么**：沿 `pack-locale-tracks`「zh 主轨、副轨可选、旧写法不回炉」既律；`official-locale-coverage` 的 en 副轨门对官方资产适用，策展时对表。

### D5: ToolBlock 通俗标签走一次性注释索引
前端经既有读面扩字段拉一份 `{server+leaf → {label, summary}}` 轻索引（内存缓存），工具块按名查；注释缺失零开销。
- **为什么**：工具事件只带名字，逐事件查询太重；索引与 `mcp-tool-scope` 读面同源同阈。
- **备选**：事件里内联注释（拒：改事件契约，惊动面太宽）。

### D6: pack manifest 覆盖复用既有 i18n 校验机
`mcpServers` 进 `LOCALE_OVERLAY_KEYS`，逐条按声明 registryName 覆盖 `description`，校验/长度 parity/回落全走既有 `pack-manifest.js` i18n 块逻辑，不写第二套。
- **为什么**：`pack-locale-tracks` 兼容性不变量（同一校验器、无双规则漂移）是既律。

### D7: 仓库注释源 `market-annotations.json`——registry 条目的第二真源（2026-11-02 finddata 需求书折入）
registry 行 `metadata.annotations` 有 64KB 上限（161 工具的五语工具级注释序列化约 99KB 塞不进），且在册 28 条 registry 条目注释全空、DB 行不可评审不可版本化。故加仓库根文件 `market-annotations.json`：一条零依赖叶 loader（`lib/market-annotations.js`，进程内缓存，缺文件/非法条目 → 空表/弃条 + warn，沿 `readJsonOr` 降级）+ `mapServer()` 一处合并（registry DB 逐字段压过文件，`mergeAnnotations` 复用，形状/校验器/投影规则零改）。
- **为什么合并点选桥而非 extension-store 读面**：桥快照同喂两平面（壹座 `mergedMarketCatalog` 与 facet 目录直读条目 `annotations`），共用对象一处合并两平面齐得；快照是内存读对象，源行零写，不违 D2。文件随镜像静态，TTL 刷新自然带新版本。
- **为什么不塞 `market-catalog.json`**：同名 bundled 条目会条级遮蔽 registry 条目（endpoint/tool_list 漂移风险）；注释文件只带注释不遮蔽条目。bundled 10 条与 registry 名集不相交，其 `annotation` 键路径零动。
- **需求书「registry 未声明的 leaf 不被新增」定谳**：注释合并按既有 `mergeAnnotations` 语义容纳文件侧 leaf，但深度视图工具行集合恒以 registry `tool_list` 为准——注释只装饰行，不发明行。
- **优先级链**：registry DB > 仓库注释源 > bundled 目录 > 原文。
- **备选**：只走 registry metadata 并提高上限（拒：跨服务改码+DB 塞策展文本无 diff 无评审）；注释进 DB 分表（拒：facet 读不到即两平面分叉，同 D1 拒因）。

## Risks / Trade-offs

- [registry metadata 透传被下游复制时注释块膨胀] → metadata.annotations 有尺寸上限（沿 manifest PACK_LIMITS 风格），校验在投影读面拒超限。
- [策展质量参差反而更难读] → 注释模板固定三件套（名/一句话/何时用），策展走 PR 评审；canonical brief 上限同 manifest description 300 字符纪律。
- [两展示面渲染分叉（壹座 vs facet）] → 投影规则只在 `pack-locale.js` 与一处共享合并助手实现，两端各挂薄封装；e2e 同口径断言（同 locale 同条目同文本）。
- [`add-agent-builder-hub` 供给区与本单展示面改动撞班] → hub 只换挂点不改进卡片内部；本单改卡片内部。两单任务表互相点名。

## Migration Plan

1. 数据先行：market-catalog.json 扩展 + 存量策展 + registry metadata 约定入 docs（无码，随时可合）。
2. lib 投影助手 + 壹座读面透出（feature 无关，字段级 additive）。
3. 展示面接入（MCP 卡/工具块/规格书）+ facet 接 locale（同一班或分班皆可）。
4. 回滚：读面投影 additive，回镜像即回滚；策展内容无迁移。

## Open Questions

- tool 注释的策展优先集（哪些 server 的 tools 先注释）待供给柜真机走查后按曝光频次定，不影响契约。
