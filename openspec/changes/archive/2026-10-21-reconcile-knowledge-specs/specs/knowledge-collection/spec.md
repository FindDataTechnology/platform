## REMOVED Requirements

### Requirement: Multi-type document ingestion
**Reason**: 2026-09-12 `rebuild-knowledge-as-file-library`（BREAKING）以本地确定性抽取管线整体替换 pageindex 时代的知识集合；本 spec 描述的摄取形态自那时起不存在。
**Migration**: `document-management`（上传摄取，零 LLM 调用）。

### Requirement: Automatic indexing on add (auto-save)
**Reason**: 异步自动索引管线随重建移除，现为同步本地摄取（UI 侧保留卡死看门狗）。
**Migration**: `document-management` 的摄取需求。

### Requirement: PageIndex-backed indexing with LLM provider reuse
**Reason**: PageIndex LLM 索引与凭据复用随重建移除——现行管线零 LLM 调用；embedding/混合检索是当时显式规划、尚未立项的 Phase 3，不在本对账刀内。
**Migration**: `document-search-index`（摄取时切块 + FTS5 索引）。

### Requirement: On-disk persistence of the collection
**Reason**: 集合落盘形态随重建更换为文件库存储。
**Migration**: `document-management` / `document-search-index` 的存储需求。

### Requirement: Indexing progress streaming over WebSocket
**Reason**: 异步索引进度流随重建移除（同步摄取无长任务进度语义）；文档状态广播的现行为由 UI 侧消费 `documents_status`。
**Migration**: `document-management-ui` 的状态呈现需求。

### Requirement: Collection retrieval by query
**Reason**: 线性 LLM 检索随重建移除，改为切块 + FTS5 + agent 工具面。
**Migration**: `document-search-index`（排序切块命中）+ `document-library-tools`（`search_library` 等 MCP 工具）。

### Requirement: Collection listing and removal
**Reason**: 列出/移除由文件库页面与库工具接管。
**Migration**: `document-management-ui`（列表/删除/集合分组）。

### Requirement: Per-document failure isolation
**Reason**: 单文档失败隔离语义由文件库摄取的 fail-closed 行为承接。
**Migration**: `document-management`（摄取失败显式报错、不落半成品）。
