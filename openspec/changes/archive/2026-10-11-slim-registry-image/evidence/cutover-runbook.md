# 切换手册（cheap-1，钉版换镜像）

前置：ccr 侧 `yizuo/mcp-registry:sha-cccd631d` 已可拉（cheap-3 直推，不经 hkccr/relay）。

## 1. 部署树两个旋钮（/opt/mcp-gateway-registry）

```
docker-compose.prebuilt.yml: image: ccr.ccs.tencentyun.com/yizuo/mcp-registry:sha-65139f8 → sha-cccd631d
.env: EMBEDDINGS_PROVIDER=sentence-transformers → fastembed
```

## 2. 滚动 + 证据链

```
cd /opt/mcp-gateway-registry && docker compose -f docker-compose.prebuilt.yml up -d registry
docker logs <new> 2>&1 | grep -E "ONNX embeddings model found|fastembed model loaded|Dimension: 384|latch"
curl -f http://127.0.0.1:8080/health        # 或容器内 7860 healthcheck
docker exec <new> /app/.venv/bin/python -c "
from registry.embeddings import create_embeddings_client
c = create_embeddings_client(provider='fastembed', model_name='all-MiniLM-L6-v2',
        model_dir=__import__('pathlib').Path('/app/registry/models/all-MiniLM-L6-v2'),
        embedding_dimension=384)
import numpy as np; v=c.encode(['验证']); print('encode', v.shape, float(np.linalg.norm(v[0])))"
```

## 3. Mongo 向量不动核对（前后 count 一致）

## 4. 保险性 /reindex（admin，用户侧或后续补）+ 用户浏览器一眼验收

# 回滚（4.3，演练性确认不实际执行）

镜像 tag 回 sha-65139f8 + .env 回 sentence-transformers + up -d。
旧镜像 torch 栈未删、宿主机 torch 权重未动 → 原样可用，无数据迁移，
索引双格式并存（-onnx 目录独立），回滚零损耗。
