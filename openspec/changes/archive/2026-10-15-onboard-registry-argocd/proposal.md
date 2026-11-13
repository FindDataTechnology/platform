## Why

registry（谦面）是唯一还在 docker compose 手滚的核心服务（cheap-1 `/opt/mcp-gateway-registry`），与 fd-prod 的 ArgoCD/GitOps 布局脱节；用户 2026-10-10 定案：registry 入驻 ArgoCD 单独立项（slim-registry-image 发布时确认部署腿暂留 compose 滚动）。

## What Changes

- compose 栈 → k8s manifests：bind mount（`~/mcp-gateway/{servers,agents,models,ssl,logs}`）迁 PV/hostPath、mongo 数据卷迁 StatefulSet 或保持外置、双容器拓扑（registry+auth-server）与 nginx 配置入 ConfigMap。
- ArgoCD application 指向 GitOps 仓（gitee），与 platform 同列。
- 迁移窗：先影子部署后切流，保留 compose 栈一键回退。

## Capabilities

### New Capabilities
（无——本 change 先以 skip_specs 占位，设计阶段确认后再声明能力）

### Modified Capabilities
- `registry-lineage`: 部署形态从 compose 栈演进为 GitOps 管理（钉版换镜像语义不变）。

## 开工前须知（2026-10-11 落，供 design/tasks 阶段直接引用）

**为什么单独立项**：registry 是唯一还在 docker compose 手滚的核心服务；用户 2026-10-10 定案「本次发布走 compose 滚动，ArgoCD 入驻另立项」。

**当前拓扑事实**（cheap-1 `/opt/mcp-gateway-registry/docker-compose.prebuilt.yml`）：
- 4 个常驻容器：registry-1、auth-server-1、mcpgw-server-1、mcp-mongodb；另有一次性 init 服务（mongodb-init/mongodb-keyfile-init，依赖 docker.io 的 python:3.14-slim/alpine:3.21）
- **全部宿主 bind mount**：`~/mcp-gateway/{servers,agents,models,ssl,logs}` + `/var/log/containers/ai-registry`；其中 `models/` 是 embedding 权重（含 `all-MiniLM-L6-v2-onnx/` ONNX 载荷与同名 torch 权重目录），`servers/` 是运行时真源（registry 会读写）
- 单容器双进程：nginx + uvicorn 同容器共存，nginx 模板由 registry 自身渲染（`/etc/nginx/conf.d/nginx_rev_proxy.conf`），**模板真源随镜像**
- mcpgw 已转存 ccr（`.env` 用 `ECR_REGISTRY` 覆盖源），mongo 容器外置但数据卷在宿主机

**迁移难点（design 必须先解决）**：
1. bind mount → PV/hostPath：`servers/` 若迁 Deployment 多副本会写冲突（现为单副本），需明确 StorageClass 与读写语义；`ssl/` 是证书需 Secret 化
2. nginx 与 uvicorn 是否拆 sidecar——拆了要改拓扑（upstream 现为 loopback），不拆则保持单容器（推荐先不拆，与上游一致）
3. mongo 状态：是留在 compose（k8s 外）还是迁 StatefulSet——前者简单但形成两套运维面
4. ArgoCD app 指向 GitOps 仓（gitee `fd-craw-private`，现有 `argocd/application.yaml` 指向 github law-private 的 k8s 路径），路径与凭据需对齐
5. 影子部署/切流与回退：保留 compose 栈一段时间双轨，compose 侧固定到当时 sha 不再变更

**顺序建议**：设计阶段先解决 1+3（状态与写语义），再写 tasks；不要与 registry 镜像发布同窗口做。
