## Why

蒸馏候选检索 v1 是关键词重叠 top-8（无 embedding），已知风险在册：漏召回会把该 UPDATE 的判成 ADD——重复经验累积。生产两日运行显示 reconcile 依赖的候选集是薄弱环（同义不同词的任务描述关键词不重叠）。车道已就绪：词元网关 embedding 组承载 `Qwen/Qwen3-Embedding-8B`（dim 4096，$6e-08/次，sub2api usage 实证 + 活体探测 SUCCESS）。

## What Changes

- **向量伴随存储**：蒸馏产物落库时 sidecar 顺带产出每条的 embedding（DistillResult 条目增 `vector` 字段，dim 4096 float32），fd-memory 以 SQLite BLOB 存进 distill 伴随表（`page_vectors(page_rel, model, dim, vector)`，markdown 真源不变、reindex 不触碰）。
- **查询侧嵌入**：调度器构造候选集前，把查询文本（近期观测摘要）发 sidecar 新端点 `POST /embed` 得查询向量，与既有候选向量做余弦 top-8；向量缺席（旧页/嵌入失败）的候选按现有关键词路径兜底并入。
- **sidecar /embed 端点**：共享令牌互信，批量输入（≤64 条），与 /distill 同一车道与预算口径（embed 调用记 llm_calls，tokens 入 distill_budget）。
- **重嵌与模型钉扎**：向量带 model 标注，模型不符（换模/升维）的候选自动落关键词兜底并记 gap——不做自动全量重嵌（成本纪律），重嵌脚本随 change 提供（按 `generated.by`+model 过滤批量重嵌）。
- **评测 v1.2**：eval 加召回对比断言（关键词 vs 向量检索在同一 scene 集上的命中差），基线入档。
- **明确不做**：全库语义检索（MCP 查询面仍 FTS——agent 面的查询语义化属后续）；跨 project 向量混合；自动重嵌。

## Capabilities

### New Capabilities

（无——落在既有 `memory-distiller`）

### Modified Capabilities

- `memory-distiller`: 「引擎 #1」需求补 /embed 端点与预算口径；ADDED「候选检索向量优先、关键词兜底、模型钉扎」需求。

## Impact

- sidecar：/embed 端点 + DistillResult 产出 vector（~60 行）；fd-memory：`distill.ts` 余弦检索 + `distill-scheduler.ts` 查询嵌入与兜底合并 + 伴随表（~120 行）；单测 +4；eval v1.2。
- 秘钥：`MEMORY_EMBED_API_KEY`（已在 paas/.env；上产时进 `fd-memory-distiller-env` secret，fd-memory 车道经 sidecar、不直连）。
- 出片：双镜像同车（sidecar /embed + fd-memory 检索）。
- 风险：4096 维 BLOB ~16KB/页——现量（<100 L2 页）无虞；调度时延 +1 次 embed RTT（~300ms，去抖路径不敏感）。
