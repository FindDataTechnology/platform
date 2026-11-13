## Why

壹座资料库的检索只有关键词一档：`documents-search.js` 只是一个 126 行的 FTS5 封装，文件头自己写明「no LLM, no embedding provider, nothing to configure」。这条路线是 2026-09-12 `rebuild-knowledge-as-file-library` 重建时选定的，而当时被替换掉的 WeKnora 方案的删除理由之一「目标用户需要企业级检索、千级文档」，FTS5 至今没有满足——`reconcile-knowledge-specs` 把这件事明确记为「Phase 3 检索升级，对账后单独立项」，此后从未立项。

后果是可感知的：中文长文档换一种说法就召回不到；用户上传一堆材料后问「里面有没有讲过 X」，答不出来时无法区分「没有」与「没搜到」。而工作区里已有两样现成的东西可以直接借：词元嵌入车道（`ciyuan-embedding-lane`）已在产；记忆面的 `memory-digest-embed-lane` 已经把「自适应预算 + 三档降级 + 慢样本如实记录」这套纪律跑通了。

## What Changes

- **先修中文词法档（今天就生效，无开关、无成本、无出网）**：`document_chunks` 用 FTS5 `unicode61` 分词器，CJK 连续串被当成单个 token，`MATCH` 命中不了，于是非 ASCII 查询全部落进 `likeDocumentChunks`——那是一条 `%整句%` 的 LIKE 全表扫描，**不排序、按切块插入顺序取前 N**。而 `document-search-index` 的需求原文要求「ranked by full-text relevance」，故这是**实现违反既有契约**，与 `law-bench` 的 `except: return []` 同类。修法是让中文查询也走带 BM25 排序的索引（FTS5 trigram 分词或等价机制），不改变「本地、确定性、无 LLM」的性质。
- **新增可选语义档**：资料库增加 `vector / hybrid / keyword` 三档检索，每档如实标注当前用的是哪一档。语义档**默认关闭**，需在资料库设置中显式开启；开启即在界面明示「本库的切块文本会送往部署配置的嵌入通道」。默认关闭时，上传、列表、预览、删除、检索的行为与现状逐字节等价。
- **切块嵌入是摄取后的异步补充，不进摄取关键路径**：文档仍从 `queued` 直接到 `ready`，摄取时长不依赖任何模型 provider。嵌入失败不影响文档可用性，只影响该文档能否被语义召回，且失败原因可查。
- **伴生向量存储**：`document_chunks` 是 FTS5 虚表，装不下向量列，需要按 rowid 关联的伴生表存放切块向量；该表随文档删除而清理。
- **混合检索**：关键词 BM25 与向量余弦以 RRF 融合，保留现有的 `loc` 定位与分页读取契约。
- **检索三态可判别**：`search_library` 把「命中 / 有效无匹配 / 嵌入通道不可用」分开，并标注实际档位。三态定义援引根仓契约 `knowledge-surface-integrity`，不另立一套。
- **存量回填**：开启语义档后对已有 `ready` 文档补算嵌入，幂等、可中断续跑、按预算限速。

**非目标（明确排除）**：
- 跨 cell 检索、共享向量库——向量与切块都留在本 cell。
- 用 pgvector / fd-text-core 承载资料库（那是另一条收敛线，本变更不碰）。
- OCR 与图片内文本（自 v1 起未接，本变更不接）。
- 统一召回面（跨知识库扇出）与跨库引用反查。
- 改 `document-management` 的两条「不依赖模型 provider」需求——本变更以默认关闭满足它们，而不是修改它们。

## Capabilities

### New Capabilities

- `library-semantic-rung`: 资料库的语义档整体契约——开启与披露、摄取后异步嵌入、伴生向量存储、与词法档的 RRF 融合、档位标注、预算与重试纪律、失败分类、成本归集、存量回填。

### Modified Capabilities

- `document-library-tools`: `search_library` 从「词法检索」扩为「档位化检索」，返回档位标注与可判别的三态；其余四个工具与项目边界、游客排除条款不变。

**关于 `document-search-index`**：不在修改面内。中文查询不排序这件事不需要改需求——它已经要求「按全文相关度排序」，是当前实现在非 ASCII 路径上违约，按既有需求整改即任务。切换分词器后该能力仍是「本地、确定性、无 LLM」，Purpose 无需改动。语义档以新能力并行存在并援引它。

## Impact

- **服务端**：`documents-search.js`（检索入口，改为档位化；中文路径改为带排序的索引检索）、`db.js`（分词器迁移 + 新增伴生向量表的版本化迁移）、`documents.js`（摄取后异步挂嵌入）、`server/library-mcp.js`（工具返回形状）。
- **新代码**：一个嵌入客户端（平台目前**没有任何**嵌入调用点，需新建），其预算/重试/降级照 `memory-digest-embed-lane` 的口径实现，不复制粘贴那套代码路径。
- **配置与凭据**：嵌入通道的地址与凭据走部署级配置；未配置时语义档不可开启且界面如实说明，不得静默失败。
- **数据**：本 cell 的 SQLite 增一张伴生表；删除文档时同步清理。存量回填为一次性动作，需限速。
- **成本**：开启语义档后嵌入调用按 cell 归集，供配额与计量取数；默认关闭时不产生任何嵌入调用。
- **契约关系**：三态条款援引根仓 `knowledge-surface-integrity`（该 change 负责契约本身与 wire/law-bench 两侧整改）；本仓负责壹座这半的合规。
