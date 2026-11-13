# 预切换向量等价实证（2026-10-10）

方法：同一组 8 条文本（中英混合，含查询语料与描述语料），
- torch 侧：生产容器 mcp-gateway-registry-registry-1 内 SentenceTransformer('/app/registry/models/all-MiniLM-L6-v2')
- ONNX 侧：本地 fastembed 0.9.0 + Qdrant/all-MiniLM-L6-v2-onnx 权重（specific_model_path 离线加载）

结果：
- 同文本跨引擎余弦：min=0.999999 mean=1.000000（float32 噪声级）
- 语义邻居 top-3 重合：8/8 全重合（24/24）

结论：两引擎数值上是同一模型，既有 384 维索引无需强制重建；
/reindex 收尾仍执行作为保险。原始向量存 evidence/torch-vecs.json。
