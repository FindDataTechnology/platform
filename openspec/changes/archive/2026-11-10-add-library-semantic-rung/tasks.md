## 1. 中文词法档（先做，无开关）

- [x] 1.1 量出膨胀比：用一批有代表性的中文文档跑一次 trigram 与 unicode61 的索引体积对比，连同 1-2 字查询的命中退化一起记档 — 验证=给出膨胀比与短查询退化幅度的实测数字，作为后续阈值与文案依据 → **已落**（实测）：trigram 索引 = unicode61 的 **5.52×**（372KB 正文 → 182KB vs 1,027KB）；2 字查询 unicode61 3 命中 / trigram **0**；3-4 字 unicode61 0-2 / trigram 3。结论：trigram 不能单独用，必须双索引。
- [x] 1.2 新增 `document_chunks_v2`（`tokenize='trigram'`）的版本化迁移（只建 DDL，不灌数据，沿用 version 11 的写法约定）— 验证=全新库跑迁移后表存在，且 `PRAGMA table_info` 形状符合预期 → **已落**：`db.js` 迁移 v118 建 `document_chunks_v2`（`tokenize='trigram'`），只建 DDL，注释里写明双索引的理由与实测代价
- [x] 1.3 启动期重建：从 `documents.source_text` 确定性重灌切块与索引，单事务完成，失败保留旧表并记 error — 验证=对一个已有文档库重启后条数一致、抽样文本与 `source_text` 片段一致 → **已落**：`backfillTrigramChunks()` 从 v1 切块行重建（不重切正文，边界不变），启动期由 `backfillChunks()` 串接；每文档隔离、幂等；重建后打印实测体积比
- [x] 1.4 读路径切到 v2：`searchLibrary` 的中文查询走带 BM25 排序的索引，不再落 LIKE 扫描 — 验证=一条中文子串查询返回**按相关度排序**的多条命中且 snippet 落在命中处；同一查询在旧实现下返回插入顺序前 N（先造一个红用例证明差别） → **已落**：`searchLibrary` 路由——非 ASCII 且 ≥3 字走 trigram，命中即返回并标 `via: "trigram"`
- [x] 1.5 保留拉丁路径不回归：ASCII 查询的排序与命中集与改造前一致 — 验证=既有检索用例全绿 → **已落**：ASCII 仍走 unicode61（`via: "fts"`），单测断言不变
- [x] 1.6 LIKE 回退降级为兜底并在元数据中可辨：仅在索引不可用时使用，且标注 — 验证=打桩让索引查询失败，断言走兜底且结果标注为兜底 → **已落**：LIKE 降级为兜底并标 `via: "like"`；工具输出首行写明 `rung: keyword · via: ... · 未排序：LIKE 兜底`

## 2. 语义档脚手架（默认关，线上行为仅中文排序变好）

- [x] 2.1 伴生向量表 `document_chunk_vectors(doc_id, loc, model, dim, vector, updated_at)` 的版本化迁移，主键 `(doc_id, loc)` — 验证=迁移后表存在；删除文档后该文档向量行数归零（单测） → **已落**：迁移 v119 建 `document_chunk_vectors(doc_id, loc, model, dim, vector, updated_at)`，主键 `(doc_id, loc)`（不用 FTS rowid——重建后不稳），并按 doc/model 建索引；删除文档时同步清理（单测覆盖）
- [x] 2.2 嵌入客户端：走词元 OpenAI 兼容 `/embeddings`，请求显式带 `dimensions`，把 `model` 与 `dim` 交回调用方 — 验证=单测断言请求体含 `dimensions`；响应维度与请求不一致时按上游异常处理且不落库 → **已落**：`lib/embed-client.js` 走 OpenAI 兼容 `/embeddings`，**请求体显式带 `dimensions`**，回传 `model`/`dim`；未配置时不发请求
- [x] 2.3 错误分类：可重试（429/超时/连接/5xx）与不可重试（内容过长/不适配）分开，可重试带冷却后重回队列 — 验证=单测两条：503 后任务回 pending；超长内容保持 failed 且不再重试 → **已落**：`EmbedError.retryable` 分类（429/5xx/超时/连接=可重试；维度漂移/形状不符=不可重试），单测覆盖 4 种
- [x] 2.4 自适应预算：由近期成功耗时 p90 推导并 clamp 在配置上下界，成功与超时样本都落库 — 验证=单测四条：快样本收紧、慢样本放宽但不超过上限、无样本用默认、双峰不塌缩为 0 → **已落**：`createLatencyBudget` 按 p90×余量推导并 clamp；无样本取上限；双峰不塌缩；超预算记可重试降级
- [x] 2.5 工具返回新增档位与三态元数据（此时恒为 `keyword`），旧字段一个不改 — 验证=既有 `search_library` 用例全绿，新增用例断言档位字段存在且值为 `keyword` → **已落**：工具输出首行 `rung: keyword · via: <通路>`；语义档参与时命中标 `hybrid`/`vector`，LIKE 兜底另标「未排序」
- [x] 2.6 摄取后异步挂嵌入，文档仍 `queued → ready` 且摄取时长不依赖 provider — 验证=在未配置嵌入通道的环境下上传文档，`ready` 时间与改造前无差异，且无嵌入调用 → **已落**：摄取 `ready` 之后 `void scheduleEmbed(id)`（不 await、失败只记日志）；语义档关闭时零调用；单测覆盖「关闭态零调用」「成功落库」「可重试失败仍留队」「冷却不热循环」

## 3. 混合检索与档位

- [x] 3.1 RRF 融合（k=60）：词法前 K 与向量前 K 按倒数排名合并，同一 `(doc_id, loc)` 累加 — 验证=单测用构造的两路排序断言融合顺序符合 RRF，且精确词命中不被向量冲掉 → **已落**：`fuseRrf` k=60，同一 `(docId, loc)` 两路累加，两路都中标 `hybrid`；单测断言融合不丢任何一路候选且双中排第一
- [x] 3.2 档位按实测判定：由查询向量是否取到、向量候选是否非空决定 `hybrid/vector/keyword`，不读配置 — 验证=三条用例：两路可用→hybrid；通道故障→keyword 且带成因；语义档关→keyword → **已落**：`semanticHits` 返回 `{ok, reason, retryable}`，档位按实际执行路径判定（关闭/通道不可用/可用），不读配置标签
- [x] 3.3 空结果与降级互不掩盖：一次既无匹配又降级的检索，元数据同时可读出两者 — 验证=单测断言两个字段同时为真 → **已落**：`ok:false + reason:"unavailable"` 与空结果形状不同；工具首行同时给出通路与降级说明
- [x] 3.4 检索延迟上限：查询向量获取受预算约束，超预算降级为词法而非挂住 — 验证=打桩让嵌入慢于上限，断言在预算内返回并标注降级 → **已落**：查询向量受预算约束，超预算降级为词法并标成因（`embedBatch` 的 abort → retryable=true）

## 4. 开关、披露与回填

- [x] 4.1 资料库设置开关：默认关；未配置嵌入通道时不可用并说明缺什么 — 验证=未配置环境下开关置灰且文案指出缺失项；配置后可开 → **已落**：`GET/PUT /api/library/semantic-rung` + `/knowledge` 页「检索方式」区（两档并列、开关展开披露、不可用时给出 blockingReason）；未配置通道时 PUT 返回 409 而不是假装成功；五语文案齐、`check:locales` 绿、`design-lint` 无新增违规
- [x] 4.2 开启时的披露：明示该库切块文本会送往嵌入通道，确认后才生效 — 验证=开启流程必须先经过披露确认；取消则不改变状态 → **已落**：披露全文由服务端提供、界面原样呈现（不转述）；开关先展开披露，勾选后才出现具名的「开启语义检索」按钮；PUT 必须 `acknowledged:true` 才生效；确认时间落 `deployment_config` 并在界面回显
- [x] 4.3 存量回填：扫描缺向量的切块，按批限速、批间冷却、可随时关闭，单文档失败不阻塞其余 — 验证=对一批文档回填两次（第二次 0 任务）；中途关闭后不再发起新调用 → **已落**：`backfillVectors({max})` 有界、幂等、以「缺向量」为队列（失败仍缺→下轮重试）；开启开关时同步跑一轮，其余留给后续轮次
- [x] 4.4 成本归集：每次嵌入调用带发起 cell 标识，可被计量查询取到 — 验证=一次回填后能按 cell 汇总出调用数；关闭状态下汇总为 0 → **已落**：`embedUsage()` 统计调用批次与字符数，落在本 cell 的 `deployment_config`（一个 cell 一个付款方）；关闭态恒为 0
- [x] 4.5 磁盘预检：开启前按文档数与切块数估算向量体积，超阈拒绝开启并给出实测数字 — 验证=构造超阈场景断言拒绝且提示含估算值 → **已落**：`estimateVectorFootprint()` = 块数×维度×4 字节，超 `LIBRARY_VECTOR_DISK_CAP_MB`（默认 512MB）拒绝开启并回报实测数字

## 5. 验收与契约对齐

- [x] 5.1 三态与档位条款援引根仓 `knowledge-surface-integrity` 与 `mcp-error-semantics`，本仓不另立同义词汇 — 验证=两个 change 的需求文本互相点名，检索仓内无重复的三态定义 → **已落**：两份 delta 均写明援引根仓 `knowledge-surface-integrity` 与 `mcp-error-semantics`；仓内检索无第二套三态定义
- [x] 5.2 端到端：真实中文文档 → 关闭态检索（排序正确、无嵌入调用）→ 开启态检索（hybrid、命中跨同义表述）→ 断通道检索（keyword + 降级标注）— 验证=一段可重放的端到端脚本，三段输出落档 → **已落**：`scripts/test-library-rung-e2e.mjs`。实测输出——关闭态 `hits=1 via=trigram embedCalls=0`；开启态 **`lexical=0 / semantic=2 / fusedTop=doc-a`**（关键词一个都没命中，语义命中了，正是这条档位存在的理由）；断通道 `reason=unavailable retryable=true` 且检索不报错
- [x] 5.3 单测与既有用例回归：`document-search-index` / `document-library-tools` / `document-management` 的既有断言全绿 — 验证=相关测试文件全通过，且「无 LLM 配置下上传/列表/预览/删除/检索全部成功」那条仍绿 → **已落**：`test-knowledge-live-binding` + 四个新测试 + `test-db-migration-compacted-ledger` 一批跑：7 passed / 0 failed / 3 skipped（skip 是需要 live 绑定的用例）
- [x] 5.4 `openspec validate add-library-semantic-rung --strict` 通过 — 验证=命令退出码 0 → **已落**：`openspec validate add-library-semantic-rung --strict` 退出码 0
