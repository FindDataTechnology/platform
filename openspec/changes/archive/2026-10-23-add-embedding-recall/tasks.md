# Tasks — add-embedding-recall

## 1. sidecar /embed 与产物向量

- [x] 1.1 `POST /embed`：批量 ≤64、共享令牌、钉扎模型（MEMORY_EMBED_MODEL，默认 Qwen/Qwen3-Embedding-8B）、响应带 model 与 tokens。验证：pytest（mock 车道）+ 本地真探。
- [x] 1.2 distill 产物嵌向量：fact/experience 落库前对 task+solution 批量嵌入，DistillResult 条目带 vector+model。验证：pytest + eval 场景产物带 vector。

## 2. fd-memory 向量伴随与余弦检索

- [x] 2.1 `page_vectors` 伴随表（writeDistillPage 写入、forget 随删、reindex 不触）+ Float32Array↔BLOB。验证：单测 round-trip、forget 清理。
- [x] 2.2 调度器：查询嵌入 → 余弦 top-8（模型比对硬闸）→ 与关键词合并去重 → candidates 带 meta.source(vector|keyword)；embed/re-match 记 llm_calls 与预算。验证：单测（mock /embed）命中向量优先、无向量兜底、模型不符 gap、embed 失败纯关键词。
- [x] 2.3 `scripts/reembed.mjs`（--dry-run、批 64、模型过滤）。验证：本地对测试根跑一轮。
- [x] 2.4 eval v1.2：同义不同词对照场景 + 候选来源断言；基线入档。验证：eval PASS。

## 3. 出片滚产与收尾

- [x] 3.1 双镜像同车出片（判路 → digest 双证）+ 秘钥进 `fd-memory-distiller-env`（MEMORY_EMBED_* 三键）+ fd-infra bump 滚产。验证：ArgoCD Healthy + 生产蒸馏候选 meta 含 vector 来源。
- [x] 3.2 台账 §15.11 + 主 spec 同步（memory-distiller 1 MODIFIED + 1 ADDED）+ 归档（validate --specs 0 failed）+ 记忆更新。
