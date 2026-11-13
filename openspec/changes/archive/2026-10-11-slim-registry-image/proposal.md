## Why

registry 生产镜像 `mcp-registry` 当前 2.72GB，其中 `/app/.venv` 占 1.9GB（70%），由 torch（739MB，仅服务本地 embedding 推理）与一批运行时零 import 的依赖（matplotlib、scikit-learn、scipy、awscli 合计约 330MB）撑起。发布链四条腿（GHA 构建 → hkccr → cheap-3 relay 回灌 ccr → 节点拉取）全被这层不变的巨物拖累：GHA cache（10GB 配额）逐出后冷构建掉到 15-25 分钟并重推 GB 级层，节点冷拉一次 2.7GB。业务代码层每次实际只有约 25MB 变化。

## What Changes

- **embedding 推理引擎换为 ONNX**：本地语义搜索/去重检查的推理从 sentence-transformers（torch 后端）切换到 fastembed + onnxruntime，模型不变（all-MiniLM-L6-v2，384 维，索引兼容，无需强制重建）；onnxruntime 已在现有 venv 中。
- **剔除死依赖**（运行时代码含测试零 import，实证于 2026-10-10）：`torch`、`sentence-transformers`、`transformers`、`sympy`（torch 传递依赖）、`matplotlib`、`scikit-learn`、`scipy`、`awscli`（仅 scripts/deploy.sh 的 ECS 运维脚本使用，非容器运行时）。
- **保留 sentence-transformers 代码路径为可选 extra**：`SentenceTransformersClient` 源码保留，依赖移入 `[project.optional-dependencies]`，默认安装不含；provider 设为 `sentence-transformers` 且未装 extra 时走现有的懒加载失败→关键词搜索降级路径（latch 机制已存在）。
- **镜像体积预算**：venv 约 1.9GB → 约 640MB，镜像 2.72GB → 约 1.45GB（减半）。
- CI（image.yml）增加镜像体积断言，防止依赖回流。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `registry-lineage`: 新增「运行时镜像依赖预算」要求——fd 谱系的 registry 镜像须维持 torch-free 的本地 embedding 推理与死依赖零容忍，镜像体积有预算上限，语义搜索行为（同模型、同维度、降级路径）不因引擎切换而退化。

## Impact

- **代码**（mcp-gateway-registry fork）：`pyproject.toml`（移除 8 个直接依赖、新增 fastembed、torch 系移入 optional extra）、`uv.lock` 重锁、`registry/embeddings/client.py`（新增 FastembedClient）、embeddings 客户端工厂接线、`docker/registry-entrypoint.sh`（ONNX 模型文件的就位检查）。
- **运维**：宿主机 `~/mcp-gateway/models/` 需补一份 ONNX 格式权重（一次性，torch 权重可保留）；切换后可用现有 `/reindex` 管理端点做保险性重建。
- **不受影响**：MongoDB 与业务数据本就外置（bind mount + 独立容器），本变更不触碰数据面；网关侧 litellm provider（`EMBEDDINGS_PROVIDER=litellm`）代码路径原样保留，但 fd 网关组内无 embeddings 模型（25 个模型实证为 0），不作为默认路线。
- **风险**：fastembed 及其依赖需在 Python 3.14 上可解析（onnxruntime/tokenizers 已在 3.14 venv 中实证存在，风险低）；上游安全修复移植时若触碰被剔除依赖所在模块，摘取范围需人工核对。
