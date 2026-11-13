## Why

registry 栈的 `mcpgw-server` 用 `public.ecr.aws/p3v1o3c6/mcpgw:1.32.0`（AWS 公共 ECR，905MB）——国内拉取可靠性差且与标准 TCR 通道脱节（slim-registry-image 探索时发现的遗留，grill Q4 定案单独立项）。

## What Changes

- 将 `mcpgw:1.32.0` 转存至 `ccr.ccs.tencentyun.com/yizuo/`（可经 hkccr→relay 标准通道），compose 引用改指 ccr 侧钉版 tag。
- 换版验证：mcpgw 转发 hop（`/mcp-proxy/{server}`）冒烟。

## Capabilities

### New Capabilities
（无——涉及时再定）

### Modified Capabilities
- `registry-lineage`: 镜像钉版要求从「钉版即可」收紧为「自建/转存镜像一律走 ccr 标准通道，上游直连引用仅允许过渡期」。

## Impact

- **已完成 2026-10-11**：`mcpgw:1.32.0` 已从 cheap-1 本地已拉镜像 tag 并直推 `ccr.ccs.tencentyun.com/yizuo/mcpgw:1.32.0`（905MB，无需外部网络、无需 relay 回灌）；cheap-1 `.env` 加 `ECR_REGISTRY=ccr.ccs.tencentyun.com/yizuo` 覆盖（不改动 compose 模板，尊重 gitee 线真源），compose 解析后 image 行 = ccr 侧钉版；滚动后容器 healthy 且转发 hop 真流量 `POST /mcp 200` 实证。
- 回滚：删除/注释 `.env` 的 ECR_REGISTRY 行即回 `public.ecr.aws/p3v1o3c6`（旧镜像仍在本地）。
- 该服务不在 registry fork 构建矩阵内（上游预构建），故 image.yml 无需改动。
