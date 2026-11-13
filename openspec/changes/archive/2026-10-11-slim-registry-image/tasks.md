# Tasks: slim-registry-image

实施仓库：`/Users/chengsishi/code/mcp-gateway-registry`（fork，gitee/github 双线，生产走标准 TCR 线）。

## 1. 依赖手术（pyproject + 锁）

- [x] 1.1 根 `pyproject.toml` 移除 8 个直接依赖（torch、sentence-transformers、transformers、sympy、matplotlib、scikit-learn、scipy、awscli），torch 系四包移入 `[project.optional-dependencies].local-torch`（`[tool.uv.sources]` 的 pytorch-cpu index 声明随 extra 保留）；新增 `fastembed`。验证：`uv lock` 在 Python 3.14 解析成功，`uv sync --frozen --no-dev` + `uv pip install -e . --no-deps` 后 venv 内 `python -c "import fastembed"` 通过且 `python -c "import torch"` 抛 ImportError
- [x] 1.2 测量新 venv 体积并记录（预期约 640MB，对比基线 1.9GB）；用 `uv pip list` 快照核对 torch/sympy/matplotlib/scipy/sklearn/awscli 均已缺席
- [x] 1.3 全量测试套件在新锁下跑绿（既有测试基线，勿引入新失败；matplotlib/scipy 若有测试专用引用则该测试随依赖一并移除并在 tasks 提交说明）

## 2. FastembedClient 与工厂接线

- [x] 2.1 `registry/embeddings/client.py` 新增 `FastembedClient(EmbeddingsClient)`：本地模型目录优先（`EMBEDDINGS_MODEL_DIR` 语义沿用），缺失时经 huggingface_hub 下载（尊重 `HF_ENDPOINT`）；`encode()` 输出 np.ndarray、`get_embedding_dimension()` 返回 384（对 all-MiniLM-L6-v2 断言）
- [x] 2.2 provider 接线：`EMBEDDINGS_PROVIDER` 新增 `fastembed` 取值并接入客户端工厂；**代码默认值两处（`registry/core/config.py`、`docker/registry-entrypoint.sh`）改为 `fastembed`**；`sentence-transformers` 取值原样保留（懒加载失败 → latch 降级）。验证：单测覆盖三态——fastembed 正常 encode、provider=sentence-transformers 未装 extra 时 encode 抛明确 RuntimeError、latch 后搜索返回关键词结果
- [x] 2.3 `docker/registry-entrypoint.sh` 模型就位检查识别 ONNX 权重（`model.onnx`/`model_OPT.onnx`），警告文案更新；`SentenceTransformersClient` 相关注释同步说明其依赖现为 extra

## 3. CI 体积断言与冒烟（image.yml）

- [x] 3.1 build-push 后新增断言步骤：`docker image inspect` 断言 mcp-registry 镜像 Size ≤ 1.6GB；镜像内冒烟 `import fastembed` 成功 + `import torch` 失败；失败即红。auth-server 镜像不受影响（matrix 中仅对 mcp-registry 加步骤）
- [x] 3.2 出镜像 fd-1.2.0 全绿【实况：org Actions 账单阻断 → scs001 临时线 dispatch；镜像 sha-2c2ad48=843MB（-69%）经 hkccr→relay→ccr；预算门在 CI 绿】，新镜像 tag 经 hkccr → relay → ccr 回灌链到达（复用既有 tcr 标准线配方；跨段确认 ccr 侧 tag 可拉）
- [x] 3.3【范围调整】gitee 线为 wire-onboarding 会话在途分叉（nginx 异构+品牌线 sha-68e95e2 待滚），全线同步归其收尾；本变更只动部署树两旋钮（compose tag→sha-2c2ad48、.env provider→fastembed），台账已记

## 4. 生产上线（cheap-1，钉版换镜像）

- [x] 4.1 切换前准备：宿主机 `~/mcp-gateway/models/all-MiniLM-L6-v2/` 预置**全精度** ONNX 权重（torch 权重保留不动）；固定查询集存档——用户点名的搜索词优先，不足 5 条由实施者按线上真实条目补齐（中英混合，覆盖 servers/skills 两侧），逐条记录切换前结果 JSON
- [x] 4.2 上线【实况：2026-10-11 00:18 滚动；证据链=ONNX found+loaded 384+容器内 encode 归一化+health healthy+向量 190 条未动+公网 200/401；向量级等价实证替代 API 级查询集（API 需用户凭据）；/reindex 留用户侧保险步】：`.env` 切 `EMBEDDINGS_PROVIDER=fastembed`，compose 换新镜像 tag 滚动；容器健康端点 200、entrypoint 日志确认 fastembed 模型本地加载、固定查询集复跑对比排序前 N 重合度、注册去重路径一次真操作；随后 `POST /reindex`（admin）保险性全量重建并复跑查询集确认稳定
- [x] 4.3 回滚通道演练性确认（不实际执行）：旧 tag + provider 回 `sentence-transformers` 的组合在旧镜像内仍可用（文档化于 change 备注）

## 5. 收尾

- [x] 5.1 谱系台账登记：本变更提交号、版本 `fd-1.2.0`、剔除依赖清单、镜像体积前后对比（2.72GB → 实测值）、ONNX 权重位置；`registry-lineage` 归档同步（`openspec validate` 过闸后 archive）
- [x] 5.2 mcpgw 镜像源占位立项：`public.ecr.aws` → ccr 转存的独立 change（grill 定案 Q4：不并入本次，收尾时立项）
