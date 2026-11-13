# 对齐词元嵌入维度契约与生产现实

## Why

代码微批（optimize-paas-module-audit N-11）实施「响应向量维度不符 SHALL 拒绝」时发现 spec 与生产互相矛盾：

- spec 写死契约 = `Qwen/Qwen3-Embedding-8B` 配 `dimensions=1024` 截断；
- 生产实证（fork patch `ciyuan-v0.2.16-16` 验收第⑥条）= 钉扎 Nebius 下**维度 4096 稳定**；
- 唯一在产消费方 `fd-memory/distiller/engine.py:204` 调用 `embeddings.create(model=...)` **不传 `dimensions`**，拿的是上游原生维度。

若照 spec 硬编码 1024 守卫，会把在产记忆链的每一笔 4096 维响应判为漂移。裁定：**1024 是调用方显式请求时的截断选项，不是部署默认维度**；默认（无 `dimensions`）取账号钉扎 provider 的原生维度（现为 4096），跨 provider 一致性由既有账号级钉扎保证。

守卫按可判定面实施（sub2api fork `backend/internal/service/openai_embeddings.go`）：请求声明 `dimensions=N` 时每个响应向量必须 N 维；批次内向量长度必须一致；`encoding_format=base64` 字符串与无 `data` 数组的错误形状不属本守卫判定范围。违规按上游异常口径返回（handler 非 failover 路径 502，不写坏向量、不计费）。

## What Changes

- `ciyuan-embedding-lane`「嵌入模型与维度为显式契约」Requirement 改写 + 场景按现势重述（保留同名场景与新守卫语义）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ciyuan-embedding-lane`：维度契约口径 MODIFIED。

## Impact

- spec 文本 + fork 代码（另仓提交）；生产出片/滚版待静窗，不在本 change 内。
