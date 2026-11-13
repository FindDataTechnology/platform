# Proposal: reconcile-knowledge-specs

## Why

知识面四份 spec（合计 25 条需求）描述的系统中，两份在代码里当天即死、两份描述两代之前的管线，而真正在管现状的另有四份 spec——任何基于这四份死/旧 spec 的迭代都没有可信锚点。具体：`weknora-integration`（8 需求）与 `weknora-ui`（3 需求）描述的 WeKnora sidecar + iframe 于 2026-08-04 落地当天即被反杀（commit `ef60adcf` "Removed WeKnora integration (replaced with local PageIndex)"），此后两个半月是无代码的死信；`knowledge-collection`（8 需求）与 `knowledge-collection-ui`（6 需求）描述的 pageindex LLM 索引管线已被 2026-09-12 `rebuild-knowledge-as-file-library`（BREAKING）整体替换为本地确定性抽取 + FTS5 + agent MCP 工具。现管真源是 `document-management` / `document-management-ui` / `document-search-index` / `document-library-tools`（另 `document-collections`），其中前两份头注还残留「All requirements removed by bundle-weknora-knowledge change / WeKnora now handles…」的过时注释，`PRODUCT.md:34` 仍在宣传一个不存在的「bundled WeKnora knowledge sidecar」。刚完成的 33 项 Purpose 回填让死 spec 看起来像活的，错上加错——本刀先对账，Phase 3 检索升级才有立项地基。

## What Changes

- **BREAKING（规格层）** REMOVED `weknora-integration` 全部 8 条需求：能力退役。零代码变更（代码 08-04 已删，无可删）。
- **BREAKING（规格层）** REMOVED `weknora-ui` 全部 3 条需求：同上，无路由、无实现、生产导航只可达 `/knowledge`。
- **BREAKING（规格层）** REMOVED `knowledge-collection` 全部 8 条、`knowledge-collection-ui` 全部 6 条需求：现行行为已由 document-* spec 全量接管（`/knowledge` 路由与上传/状态/预览/删除/集合/「开始对话」在 `document-management-ui`；摄取管线在 `document-management`；分块索引在 `document-search-index`；agent 工具面在 `document-library-tools`）。曾考虑「重写成文件库现状」，否决——两套 spec 管同一面是重复真源，与当初删 WeKnora 时「doubles the maintenance burden」的裁决同构。
- 归档同步时顺手清除 `document-management` / `document-collections` 头部 WeKnora 残留注释（注释行，非需求变更），并给四份退役 spec 依仓库既有先例（`document-management` 空壳式）留「需求已退役 → 指向 document-*」的指针注释，不物理删目录。
- `PRODUCT.md:34` 删除「bundled WeKnora knowledge sidecar (spawned by the Electron supervisor when `WEKNORA_BASE_URL` points at localhost)」虚假陈述，改为如实描述本地文件库（本地确定性抽取 + FTS5 + library MCP 三工具）。
- **明确不做**：Phase 3 检索升级（embedding/混合检索/CJK 分词，09-12 重建时显式规划未做——对账后单独立项）；OCR 接线（v1 起未接）；任何代码行为变更；复活远程 WeKnora。注：当初删 WeKnora 的动机之一「目标用户需要企业级检索、千级文档」FTS5 并未满足——此事实作为 Phase 3 立项时的输入记录在案，不在本刀裁决。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `weknora-integration`: REMOVED 全部需求，能力退役（代码不存在）
- `weknora-ui`: REMOVED 全部需求，能力退役（代码不存在）
- `knowledge-collection`: REMOVED 全部需求，现管真源 = `document-management` / `document-search-index` / `document-library-tools`
- `knowledge-collection-ui`: REMOVED 全部需求，现管真源 = `document-management-ui`

## Impact

- 纯规格与文档：四份 REMOVED delta spec + 两处头注清理 + `PRODUCT.md` 一段；零代码、零部署、零生产风险。
- 归档后主 spec 需求总数 -25，`openspec validate` 基数相应变化。
- 33 项 Purpose 回填（工作树未提交）中这四条随之退役——其中 weknora 两份的 Purpose 描述的正是已死系统。
