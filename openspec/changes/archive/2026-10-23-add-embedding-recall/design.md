# Design — add-embedding-recall (v2.2)

## Context

车道实证（2026-10-22）：token 网关 embedding 组承载 `Qwen/Qwen3-Embedding-8B`（dim 4096、$6e-08/次、usage 行与活体探测双证）；秘钥在 paas/.env（MEMORY_EMBED_*）。v1 候选检索=关键词重叠 top-8，漏召回→重复 ADD 在册为已知风险。

## Decisions

### D1 向量产在 sidecar、存在 fd-memory 伴随表

- `DistillResult` 的 fact/experience 条目增 `vector`（float32 数组）：sidecar 在写产物前对 task+solution 拼接文本调用嵌入（一次批量）；fd-memory `writeDistillPage` 时写入 `page_vectors(page_rel PRIMARY KEY, model, dim, vector BLOB)`。
- 真源纪律不破：vector 是派生伴随（如同 FTS 索引），页删除/forget 时随行删除；reindex 不重建它（rebuild 走重嵌脚本）。

### D2 查询嵌入在调度时机、余弦在 fd-memory

- 调度器 distillOne 现有 `queryFor`（近期 40 条摘要）→ `POST /embed`（1 条）→ 余弦 top-8 vs 候选向量 → 与关键词 top 合并去重（向量序优先，关键词补位）→ candidates 进 /distill 请求。查询失败 = 纯关键词路径（降级开放）。
- 余弦在 node 侧手写（4096 维点积/模长，无依赖）；float32 BLOB ↔ Float32Array。
- 预算与留痕：embed 调用由调用方记 llm_calls（stage=embed）并入 distill_budget（fd-memory 侧把 /embed 响应的 tokens 累加）。

### D3 模型钉扎与重嵌

- page_vectors.model 与 /embed 响应 model 比对：不一致（换模/维度不同）的候选不参与余弦、记 gap 行（stage=vector_model_mismatch）。
- `scripts/reembed.mjs`：遍历 page_vectors + 缺行页 → 批量 /embed → 更新（--dry-run 支持全新布；分批 64）。

### D4 评测 v1.2

- eval-distill 场景加同义不同词对照（现有场景的措辞改写版作查询）：断言向量路径命中（旓名单在 candidates 请求体可见——调度器把候选来源标记 vector/keyword 传入请求 meta，eval 断言之）；基线数字入档。

## Risks / Trade-offs

- [16KB/页 BLOB 增长] → 现 L2 页 <100；1 万页 ≈ 160MB，PVC 5Gi 无虞；超规模时换 sqlite-vec（远期）。
- [嵌入调用失败] → 关键词兜底即降级路径；gap 记录。
- [跨模型余弦无意义] → 模型比对硬闸（MUST 场景）。

## Migration Plan

双镜像同车（sidecar /embed + fd-memory 检索）；无数据迁移（存量页无向量自然落兜底，可选跑 reembed）。回滚 = 回镜像（page_vectors 表留存无害）。

## Open Questions

（无）
