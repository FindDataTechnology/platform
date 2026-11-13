# Design: slim-registry-image

## Context

生产镜像 `mcp-registry:sha-65139f8` 为 2.72GB，层析：`/app/.venv` 1.9GB（torch 739MB + awscli 147MB + scipy 122MB + transformers 60MB + litellm 85MB + onnxruntime 62MB + sympy 43MB + sklearn 34MB + matplotlib 27MB + …）、apt 层 153MB（nginx 系）、基底约 130MB、应用代码与前端约 25MB。数据库与业务数据早已外置（mongo:8.2 独立容器 + named volume；`~/mcp-gateway/{servers,agents,models,ssl,logs}` bind mount），镜像胖因纯粹是 upstream 平铺 60 个直接依赖、924 个锁定包的多云全家桶闭包。

实证事实（2026-10-10，fork @ 63126fe8 + cheap-1 实机）：

- `sentence_transformers` 仅在 `registry/embeddings/client.py` 两处懒加载 import（TYPE_CHECKING + `_load_model` 内部）；torch 无任何直接 import，纯为 sentence-transformers 的后端。
- matplotlib / scikit-learn / scipy 在 `registry/ auth_server/ api/ scripts/ tests/` 全域零 import。
- awscli 仅被 `scripts/deploy.sh`（ECS 运维脚本）以 CLI 方式调用，容器运行时（entrypoint、registry、nginx）不触达。
- boto3 有真实运行时 import（federation/agentcore_client 顶层、cognito_manager、mongodb_connection 懒加载）——保留，botocore 仅 27MB。
- yara_x 服务技能/agent 安全扫描（`security_scans` 目录是活功能）——保留。
- onnxruntime 已在 venv（62MB）且代码零 import——本变更使其成为推理引擎，变废为宝。
- 网关 `token.finddatatech.cloud` 组内 25 个模型全部是 chat 模型，无 embeddings 车道 → litellm 路线需新增外部依赖，不取。
- `registry/api/embeddings_admin_routes.py` 已有 `POST /reindex` 管理端点；搜索仓库已有 embeddings 失败 latch → 关键词降级机制。
- auth_server 镜像仅 592MB，因其有独立 `auth_server/pyproject.toml + uv.lock`——upstream 自己已示范按需裁剪。

## Goals / Non-Goals

**Goals**

- 镜像 2.72GB → 约 1.45GB（压缩后 ≤1.6GB 预算线），四条发布腿同步受益。
- 语义搜索/去重检查对外行为零变化：同模型（all-MiniLM-L6-v2）、同维度（384）、既有索引无需强制重建。
- 死依赖零容忍成为可执行的 CI 约束，而非一次性清理。

**Non-Goals**

- 不拆 base 镜像分层（阶段二候选，见 Open Questions）。
- 不动 nginx 单容器拓扑、不动 Mongo/数据面、不动 mcpgw（其 `public.ecr.aws` 依赖另行立项）。
- 不做「独立 registry 最小 pyproject」的深裁剪（auth_server 式），fork 分歧成本暂不划算。
- 不启用 litellm provider 作为默认（网关无 embeddings 模型，实证）。

## Decisions

### D1: 推理引擎选 fastembed（ONNX），不选 litellm API、不手写 optimum 导出

- **fastembed**（Qdrant）原生支持 `sentence-transformers/all-MiniLM-L6-v2` 的 ONNX 权重，输出 384 维与现状一致；依赖为 onnxruntime（已在 venv）+ tokenizers + huggingface_hub + numpy，净增约 15-20MB。
- 否决 **litellm API 路线**：fd 网关组 25 模型无一是 embeddings（2026-10-10 实证），启用即引入新外部依赖与调用成本，且注册去重、实体索引等高频内部路径会反复打 API。
- 否决 **optimum/onnxruntime 手工导出**：需在构建期跑 torch 导出脚本，等于构建仍依赖 torch，瘦身归零。
- 权重数值差异：同权重 ONNX 与 torch 推理的余弦相似度在浮点噪声级，既有索引按原向量继续命中；`/reindex` 端点作为切换后的保险性重建手段（幂等，不强制）。

### D2: 依赖手术在 fork 的根 `pyproject.toml` 上做，不做独立最小锁

- 移除 8 个直接依赖：`torch`、`sentence-transformers`、`transformers`、`sympy`、`matplotlib`、`scikit-learn`、`scipy`、`awscli`。其中 torch/sentence-transformers/transformers/sympy 移入 `[project.optional-dependencies] local-torch` extra——`SentenceTransformersClient` 源码保留，装 extra 即可用，谱系内保留逃生门。
- `uv.lock` 全量重锁；`[tool.uv.sources]` 的 pytorch-cpu index 声明随 extra 保留（装 extra 时仍走 CPU 轮子）。
- 否决 auth_server 式独立 `registry/pyproject.toml`：需重排包结构（包根在仓库根），上游安全摘取的对照成本翻倍；收益（再省约 400MB）留阶段二评估。

### D3: FastembedClient 按既有 EmbeddingsClient 契约实现，provider 命名 `fastembed` 并成为本地默认

- `registry/embeddings/client.py` 新增 `FastembedClient(EmbeddingsClient)`：`encode() -> np.ndarray`、`get_embedding_dimension() -> int`，模型目录优先取本地路径（沿用 `EMBEDDINGS_MODEL_DIR=/app/registry/models/<name>` 的 host bind mount），缺失时经 huggingface_hub 下载（`HF_ENDPOINT` 可指镜像，操作项见 tasks）。
- 工厂侧：`EMBEDDINGS_PROVIDER` 新增取值 `fastembed`，且**代码默认值随之改为 fastembed**（`registry/core/config.py` 与 `docker/registry-entrypoint.sh` 两处默认均改）——镜像内已无 torch，默认值指向 torch 后端是自相矛盾的配置，漏配 env 时会静默降级成纯关键词搜索。原 `sentence-transformers` 取值行为不变（懒加载失败 → latch 降级，spec 已覆盖）。生产 `.env` 同步切 `fastembed`。
- entrypoint 的模型就位检查改为识别 ONNX 权重文件（`model.onnx` / `model_OPT.onnx`），警告文案同步。

### D4: CI 体积断言做在 image.yml 内，不做独立审计 workflow

- build-push 后加一步：`docker build` 产出的本地镜像跑 `docker image inspect` 断言 `Size <= 1.6GB`；再跑 `docker run --rm <img> .venv/bin/python -c "import fastembed"` 冒烟 + 依赖缺席断言（`import torch` 必须失败）。
- 复用既有 matrix，不新增 workflow；断言失败即 job 红，挡住合入。

### D5: 发布与切换纪律（grill 定案 2026-10-10）

- **版本**：`fd-1.2.0`（minor——依赖闭包与默认 provider 是部署可见变化）；`image.yml` 的 `BUILD_VERSION` 维持手改，不引入自动推导（保住钉版换镜像的显式性）。
- **分支基线**：从 `origin/main` 独立开分支。在途的 `fd-key-group-fallback`（9 个 auth/tier-gate 提交）与本变更零文件交集，两条线并行、互不等待。
- **权重预置**：手工预置**全精度** `model.onnx`（~90MB，质量保守）；懒下载仅兜底；量化版 `model_OPT.onnx` 留后续独立评估。
- **上线窗口**：CI 绿 + 断言过闸后即滚（单容器滚动=秒级中断、回滚一键、搜索有 latch 托底），不约低峰窗口。
- **验收协议**：切换前固定查询集存档（用户点名的搜索词优先，不足 5 条由实施者按线上真实条目补齐，中英混合覆盖 servers/skills）→ 切换后同集复跑，对比排序前 N 重合度 → `POST /reindex` 全量重建 → 复跑确认稳定。
- **双线纪律**：github main 合入触发出镜像后，按 lex-legal 配方同步 gitee 线（main 与部署分支同 ref），并 ff cheap-1 `/opt/mcp-gateway-registry` 部署树（该树跟踪 gitee，是 bind-mount 模板真源）。
- **mcpgw 不并入**：其 `public.ecr.aws` 镜像源转存为独立小 change，本次收尾（任务 5.1）时立项占位。

## Risks / Trade-offs

- [fastembed 或其依赖无 Python 3.14 轮子] → onnxruntime/tokenizers 已在当前 3.14 venv 实证存在；fastembed 本体纯 Python。任务 1.1 第一步就是本地 `uv lock` + `uv sync` 解析验证，解析失败即暴露，回退方案是 pin fastembed 旧版或阶段二改手写 ONNX 会话客户端（onnxruntime 直载）。
- [ONNX 权重与 torch 权重向量漂移导致召回质量下降] → 同模型同维度，差异为浮点噪声级；上线后跑 `/reindex` 全量重建（语料仅数百条目，分钟级）即彻底消除。
- [上游安全摘取触碰被剔除依赖的模块] → 台账流程已在谱系 spec 中（上游安全单行道）；摘取时冲突即人工核对，本设计在 extra 中保留 torch 系使「临时装回验证」始终可行。
- [剔除 scipy/sklearn 实为某懒加载路径的隐式依赖] → 全域 import 扫描已覆盖 `registry/ auth_server/ api/ scripts/ tests/`；任务中加双保险：重锁后跑全量测试套件 + 镜像内 import 冒烟（D4）。
- [镜像预算线 1.6GB 偏松/偏紧] → 目标 1.45GB 留 10% 余量给依赖自然增长；预算线写进 spec，收紧只需改断言一处。

## Migration Plan

1. fork 从 `origin/main` 开分支实施 + 全量测试绿 → 合入 main（`BUILD_VERSION` 推进 `fd-1.2.0`）触发 image.yml → 新镜像过体积断言与冒烟。
2. gitee 线同步（main 与部署分支同 ref）+ cheap-1 `/opt/mcp-gateway-registry` 树 ff。
3. cheap-1：`~/mcp-gateway/models/all-MiniLM-L6-v2/` 预置全精度 ONNX 权重（torch 权重原样保留）；固定查询集存档（用户点名优先）。
4. `.env` 切 `EMBEDDINGS_PROVIDER=fastembed`，compose 滚动换镜像 tag（钉版换镜像，谱系 spec 既有约束）；CI 绿即滚，不等低峰。
5. 验证：健康端点、固定查询集对比（排序前 N 重合度）、注册去重路径一次真操作；随后 `POST /reindex` 保险性重建并复跑查询集确认稳定。
6. 回滚：镜像 tag 回退 + `.env` provider 回 `sentence-transformers`（旧镜像内 torch 栈未删，原样可用）——单 compose 滚动，无数据迁移，索引双格式并存无损。

## Open Questions

- 阶段二是否做 base 镜像分层或独立最小锁（再压至约 1GB）——待本变更上线后按发布频次与 GHA cache 逐出率数据再定，不影响本设计。
- 175MB 的 torch 权重目录在切换稳定后是否从宿主机 mount 清理——运营决策，不阻塞。
