## Context

- 后端零缺口：`facet/mcp-catalog.js` 两端点已支持 `?locale=`（`add-mcp-annotation-overlay` 真机五语验过），缺口纯在 `facet/web/src/McpCatalog.tsx`——列表（:90）与深度（:157）fetch 均裸调不带 locale，数据语言由浏览器 Accept-Language 决定，与右上角五语切换器（`useLanguage().locale`，经 `@/i18n/useLanguage` 共享原语）脱钩。
- 布局现状：工具区 `ul.space-y-2` 单列全宽卡（193 工具直滚），`whitespace-pre-wrap` 无 clamp（上游 description 带多行 DSL 文档，单卡十余行）；同页技能区已用 `sm:grid-cols-2`（:294）——同页两种密度范式。页面无内容列 max-width。
- 数据缺口（不在本单）：`fd-wire-cell-*` 三条（193 工具×3）无注释，finddata 23 条交付未覆盖客户实例——回执补记请其拍板。
- 设计纪律：impeccable v4.4.0 **Operate 模式**（可扫读性/密度/任务完成优先）；facet/web 与主应用共享 design tokens（`@` alias 指 web/src），新 UI 走既有原语（card/status tokens），不发明第二套色板。

## Goals / Non-Goals

**Goals**：数据语言与切换器同源同变；193 工具从「直滚清单」变「可分组可过滤的多列扫读面」；长描述受约束可展开；无注释条目行为逐字节不变。

**Non-Goals**：后端 API 零改；注释数据形状零改；列表页信息架构不动（仅吃 locale 修复）；不做服务端搜索/分页（客户端过滤足够）；不做 wire cell 注释数据（finddata 拍板）。

## Decisions

### D1: locale 取 `useLanguage().locale` 显式传参，切换即重取
两处 fetch 改 `fetch(\`/api/mcp-catalog?locale=${locale}\`)` 与深度同构；`locale` 进 deps 的 useEffect，`changeLocale` 触发 `languageChanged` → 组件重渲染 → 重取。列表→深度导航保持现有 props 流。
- **为什么显式传参而非继续靠 Accept-Language**：切换器承诺的语义就是「整个界面跟随我的选择」；Accept-Language 是浏览器偏好，两者必然分叉（本缺陷的根因）。
- **为什么不是全局 fetch 拦截器**：facet/web 只有这几处数据 fetch，拦截面过大且引入隐式行为；显式传参与既有 `?locale=` 契约对齐。
- **回落**：`locale` 取值恒有定义（useLanguage 兜底 DEFAULT_LOCALE），无请求失败态新增。

### D2: 工具区 = 前缀分组 + 客户端过滤 + 响应式多列
- 分组：按工具名首段前缀（`_` 前的段，如 `alerts`/`compute`）归组；单成员组并回「其他」桶，防碎片。分组标题带计数。
- 过滤：单个文本框对 `name + annotation.name + summary` 做 includes 匹配（大小写不敏感），纯客户端；无结果给空态行。
- 网格：`grid gap-3 sm:grid-cols-2 xl:grid-cols-3`（对齐技能区既有范式），内容区 `max-w-6xl` 收口（与 header 对齐）。
- 展开：description（注释 summary 优先、原文兜底）默认 clamp 到 ~4 行（`line-clamp`），「展开/收起」per-tool 本地 state；原始 name 恒显（等宽、不替换——spec 契约）。
- **为什么前缀分组而非 tool_list 元数据**：registry 条目 tool_list 只有 name+description，无分组字段（fd-quant 的 8 组信息在 tool-surface.json，不入 registry）——前缀是零数据依赖的天然信号，实测对 193 工具的 wire cell 与 50 工具的 fd-quant 都成立。
- **备选拒**：虚拟滚动（拒：26 进程共享 pod 下引复杂度不值，分页/分组已解决扫读）；服务端分组（拒：改 API 违 Non-goal）。

### D3: i18n 新键五语齐上
分组「其他」、过滤占位、展开/收起、空结果——走 facet 既有 i18n 管道（`mcp.depth.*` 命名空间延续），五语言文件同批补齐（`official-locale-coverage` en 门对官方资产适用）。

### D4: 验收走 impeccable 批次纪律
构建后**一轮**批量截图（桌面+窄幅两档）+ 缺陷单批修 + 至多一轮确认，不做开放循环。视觉门对齐 impeccable 的 Operate 清单（对齐/密度/层级），非主观审美。

## Risks / Trade-offs

- [重取风暴：切换语言连续点击] → fetch 无去重锁但 React 状态覆盖幂等（后写胜），且无写副作用，风险可忽略；如需可加 in-flight guard（单 flight，同 registry-bridge 模式）。
- [前缀分组对个别服务失真（命名不规则）] → 单成员并「其他」桶兜底；分组纯展示层，不影响数据与 API。
- [clamp 阈值砍掉关键信息] → DSL 参数行属尾部内容，preview 取头 4 行 + 展开保全量；注释 summary（≤200 字符）几乎不受影响。
- [与市场班（overhaul-market-catalog-presentation）在途撞 facet/web] → 该班在主应用侧（web/src）与 pack 面，`McpCatalog.tsx` 归本单独占；提交前照例 `git branch --show-current` 防 shared worktree 劫持。

## Migration Plan

1. locale 接线（两处 fetch + deps）+ i18n 键——最小可合。
2. 工具区重排（分组/过滤/网格/clamp）——纯展示层，单测锁行为（分组数/过滤/clamp 三态）。
3. 出片随既有 facet 镜像通道；回滚=回镜像即回滚，无状态。
4. finddata 回执补节（数据拍板）与出片无关，随时可发。

## Open Questions

- 「其他」桶的命名与排序位置（尾部 vs 字母序归位）——走查时按真机眼见定。
- max-w-6xl 还是更紧（xl 断点下 3 列是否显挤）——impeccable 批次截图后定。
