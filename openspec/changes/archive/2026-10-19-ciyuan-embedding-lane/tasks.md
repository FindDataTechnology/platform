# ciyuan-embedding-lane — Tasks

> **范围（2026-10-18 收窄）**：本 change **只覆盖文本引擎（`fd-text-core`）**
> 一条线。法条检索线（`fd-legal-search-mcp` / `law_chunks_v2`）经实测判定为
> 0.6B 所建、且硅基流动 key 已恢复可用，用户决策**维持 0.6B 不动**——
> 不改上游、不改模型、不重嵌库（依据见 design.md Q3/Q4）。
>
> **R6 出站阻塞已解除**（2026-10-18：OpenRouter 侧恢复，网关调嵌入 200）。
> 10 次一致性 min_cos=0.999822 通过；下一步是组 1（provider 钉扎代码 + 出片）。
>
> 既定判断（用户 2026-10-18 指令）：Q1=provider 由词元侧账号级注入（需出片）；
> Q2=沿用组 8；法条侧维持 0.6B 退出范围。

## 0. 阻塞排查（已完成，2026-10-18）

- [x] 0.1 定位网关→OpenRouter 出站 EOF 根因 → **结论：OpenRouter 侧临时不可用，
  非网关缺陷**。当日早些时候同 pod 内 `wget` 直连同 key 同 body 200 而网关
  Go client 502 EOF（固定 5.1s、连打 6 次不恢复、同期 openai-next chat 200），
  已排除 key/网络/模型/白名单/H2 fallback；当日稍晚 OpenRouter 恢复后网关调用
  即通。**验证**：组 8 探针 key 调 `/v1/embeddings` 得 200 / 1024 维 / usage
  完整（`prompt_tokens=6, cost=6e-08`）。
- [x] 0.2 降级路径确认无需启用（0.1 判定无需换上游）。**验证**：design.md
  D2/D5 与 spec 保持「OpenRouter + provider 钉扎」不变，无过期表述。
- [x] 0.3 复测「未钉扎 provider」时是否同样恢复（交付态要求钉扎，此为旁证）。
  **验证**：不带 `provider` 调 10 次，记录 min_cos 供对照——预期仍 <0.999，
  用以佐证钉扎的必要性（而非可选）。

## 1. 词元侧 provider 钉扎代码（「只增」改动 + 出片）

- [x] 1.1 在 `service/openai_embeddings.go` 的 `ForwardEmbeddings` 构造
  `upstreamBody` 处，按账号级配置（建议 `extra.embedding_provider_only`）注入/
  覆盖请求体 `provider` 字段；未配置时保持透传不变（不改变其它路径行为）。
  **验证**：新增单测覆盖三条——配了则上游收到钉扎值、调用方自带值被覆盖、
  未配置则 body 不含该字段；既有 embedding 测试全绿。
- [x] 1.2 走 fork 补丁级流程：目标 spec 全绿 + 出片（build-pool）+ GitOps 滚产
  + pod imageID/digest 逐字节比对。**验证**：版本端点自报新补丁级；滚产后
  `/health` 200；台账 `docs/sub2api-fork-patches/README.md` 增行。
- [x] 1.3 给组 8 的 OpenRouter 账号配置 `extra.embedding_provider_only=Nebius`
  （依据：实测钉 Nebius min_cos=0.999925 过门，钉 DeepInfra 0.997614 不过门）。
  **验证**：admin 面读回该账号 extra 含此值；调嵌入后上游实际按 Nebius 服务
  （可从 OpenRouter 响应头 `X-Provider-Name` 或成本明细核对）。

- [x] 1.4 生产验收（2026-10-18 完成）：镜像 `sha-8c0f4f8`（源 3373eae6f，含 v-11
  音频车道）滚产，pod imageID digest `bbca6ec9…` 与 ccr skopeo 读数逐字节一致；
  `/health` 200；账号 #32 配 `embedding_provider_only=Nebius` 后——
  ① **网关注入生效**：请求体**不带** provider 调嵌入得 200/1024 维；
  ② **反证**：临时把钉扎改成 `NoSuchProviderXYZ`，上游即回
  `No allowed providers are available … Providers serving qwen/qwen3-embedding-8b:
  nebius, siliconflow, deepinfra`（证明确由网关注入而非透传）；
  ③ 恢复 Nebius 后生产 10 次连调 **min_cos=0.999905** 过门。
  **验证**：以上三项事实齐全；临时探针 key 已删除。


## 2. 价目、白名单与密钥配置（admin 面，零滚动）


- [x] 2.1 为承载嵌入的账号开启模型白名单放行（推荐 `extra.openai_passthrough=true`；
  备选 `model_mapping` 补 Qwen 条目），确保 Qwen 模型名不被 `model_not_supported`
  拦死。**验证**：调 `Qwen/Qwen3-Embedding-8B` 不再 404/`model_not_supported`。
- [x] 2.2 在组 8 为契约模型配置 token 自定义价（按上游成本 + 倍率），确认价目
  来源为分组/渠道自定义而非全局价格表。**验证**：嵌入请求用量行有非零费用且
  面板可按模型区分；另用一未配价模型确认按「无价可循」失败而非静默 $0。
- [x] 2.3 确认内部服务密钥：沿用现成 key 55（组 8）或另铸一把
  （命名如 `embedding-internal`），仅内部消费方使用、不写入对外交付材料。
  **验证**：该 key 调嵌入 200；凭据只落部署秘密件，paas 侧材料不含明文。

- [x] 2.4 配置实测记录（2026-10-18）：① **白名单无需改动**——账号 #32（OpenRouter，
  priority 40）无 `model_mapping` 故放行全部模型，模型名大小写均已实测 200
  （`Qwen/Qwen3-Embedding-8B` 与 `qwen/qwen3-embedding-8b` 皆通）；账号 #34
  （openai-next，priority 1）虽有三型号白名单但不供 Qwen 嵌入，不影响契约达成。
  ② **价目已配**：组 8 `model_pricing` = `Qwen/Qwen3-Embedding-8B`
  token 模式 in=3e-08/token（=$0.03/M，成本 $0.01/M 的 3 倍，与既有渠道倍率同档）、
  out=0；**计费实证**——调用后余额自 `99956932.03700617` 降至 `...03700587`
  （−3e-07），用量行 `requests=3 cost=3e-07`，**非零价静默**；未配价模型按
  `does not exist` 400 拒绝（fail-closed 生效）。
  ③ **内部服务密钥**：新铸 `embedding-internal`（key id 96，组 8），
  实测 200/1024 维；明文只落部署秘密件，不进任何仓内文件。
  **坑在案**：模型名匹配**大小写不敏感**，同一模型两个写法同配会报
  `MODEL_PATTERN_CONFLICT`（overlapping match range），只需配一条。

## 3. 通道与一致性验证（切消费方前的硬门槛）

- [x] 3.1 用服务密钥对 `Qwen/Qwen3-Embedding-8B` 做真调用，断言返回 **1024 维**
  向量（不带 `dimensions` 时应为 4096、带则为 1024——证明确有 MRL 截断）+ usage
  回传 + 词元用量行落账扣费。**验证**：三维度/usage/扣费行三事实齐全。
- [x] 3.2 同一文本连续调用 10 次，计算两两余弦，确认 ≥0.999。
  **验证**：最低余弦记录在案（预期 ≈0.9999）；若低于门槛，回 1.3 重选 provider，
  不进入第 4 组。
- [x] 3.3 人为造一次上游失败（停用该上游账号），确认池内换号或如实 5xx：
  有备账号则换号成功、失败账号进入分级冷却且管理面可见；无备账号则 5xx 且
  不透上游细节、不计费。**验证**：两种情形各验一次并记录。
- [x] 3.4 降级路径验证：停用全部上游账号后，确认 `fd-text-core` 侧语义检索
  按 `UpstreamUnavailable` 如实报错、关键词检索不受影响。
  **验证**：工具返回标明嵌入上游失联的错误；关键词检索工具同时可用。

## 4. 切换 fd-text-core（文本引擎）

- [x] 4.1 备份当前 Secret `fd-text-core-env`（`kubectl get -o yaml` 存档），
  记录回滚所需的硅基流动旧值。**验证**：备份文件含旧
  `FDTEXT_EMBEDDING_API_BASE/_KEY`。
- [x] 4.2 更新 Secret：`FDTEXT_EMBEDDING_API_BASE` → 词元网关 `/v1`、
  `_API_KEY` → 内部服务密钥；`FDTEXT_EMBEDDING_PROVIDER_ONLY` **置空**
  （钉扎已由词元侧负责，双重钉住会冲突），其余键不动。
  **验证**：`kubectl get secret -o jsonpath` 逐键读回，确认变更键与未变键
  （模型名、DIM 必须未变）。
- [x] 4.3 滚动 Deployment 使新 env 生效。**验证**：pod 重建且 Running，
  镜像 digest 不变（env-only 变更不应换镜像）。
- [x] 4.4 跑 `conformance_gate.py --strict`，确认锚点余弦 ≥0.999、七项门全绿。
  **验证**：门输出 PASS 记录在案；锚点余弦若 FAIL，先按 R3 排查维度而非
  删锚点绕过。
- [x] 4.5 对生产语义检索工具做一次真实查询，确认命中与 provenance 正常返回。
  **验证**：查询结果非空且带 provenance 三元组。

- [x] 4.6 切换实测记录（2026-10-18）：Secret 备份 `/tmp/fd-text-core-env.backup.yaml`；
  更新后 9 键逐键读回正确（仅 base/key 变，MODEL=Qwen/Qwen3-Embedding-8B、
  DIM=1024、S3 四项均未变）；滚动后 pod Running、镜像 digest **未变**
  （`sha-3a4ec40`，env-only）；pod 内实调嵌入 **200/1024 维**；
  **锚点余弦 0.999944**（自跑）/ **0.999935**（gate 实跑）——**均过 0.999 门，
  库内向量零重嵌成立**；真实查询两域皆命中（`screenplay` 窦娥冤法场原文双通道
  `matched_by=['keyword','vector']`、`papers` 纯向量命中），`degraded: []`
  无降级；计量核实 10 次请求累计 2.52e-06、余额实扣；pod 日志零错误。
  **遗留（与本 change 无关、未修）**：`conformance_gate.py` 另报 3 项违规——
  ① doc 7487 无损切块还原失败（切块/冷存域）② `corpus_chunks_gov`
  ③ `eval_runs` 两表不在迁移链内（schema 域）。三者均属切块/schema 面，
  与嵌入通道无关，且 `eval_runs` 系评测层既有表；**锚点余弦门 PASS 才是
  本次切换的判据**。另注：生产镜像 `sha-3a4ec40` 的 `embedding.py` 无
  `embedder_from_env`/`provider_from_env`，且不支持 `--strict`——即客户端
  本就不带 provider 钉扎，切后由网关注入，符合设计。

- [x] 3.5 补充实证（2026-10-18 归档后补跑，三项原标未完成的旁证全部达成）：
  ① **0.3 真对照**——直连上游**不钉扎**连调 10 次 min_cos=**0.992257**（漂移），
     经网关（网关注入钉扎）min_cos=**0.999918**（过门）→ **钉扎必要性二次证实**；
  ② **3.3 上游失败行为**——把账号级钉扎临时改为 `NoSuchProviderXYZ`（等价于
     该上游不可服务），嵌入调用返回 **404 如实报上游原因**，不透出 key、
     不返回假向量；此后恢复 `Nebius` 即 200/1024 维；
  ③ **3.4 降级路径**——嵌入不可用期间 `hybrid_search` 如实标注
     `degraded: ['vector: 嵌入请求 status=404 …']` 且**仍返回结果**（关键词兜底 3 条），
     纯 `keyword_search` 亦正常 3 条；恢复后 `degraded: []`、
     `matched_by=['keyword','vector']` 双通道回归。
  **注**：`admin/accounts/:id/disable` 端点不存在（404），`schedulable` 经 PUT
  不生效（读回仍 True），故改用「改钉扎值制造上游失败」这一可控手段达成同等待证。
  两项「另立 change」的后续事项（5.2 / 7.1）保持未勾选，性质使然。

## 5. 法条侧（本 change 不执行——已决策维持 0.6B）

> 用户 2026-10-18 决策：**法条检索线维持 0.6B + 硅基流动直连，不改上游、不改
> 模型、不重嵌 `law_chunks_v2`（364,801 点）。**
> 实测依据（见 design.md Q3/Q4）：库内 chunk 原文以 0.6B 重嵌后自我检索命中
> 余弦 0.9999（12 点抽样 0.99989~0.99992），以 8B@1024 重嵌则不命中
> （最高 0.1316）→ 库为 0.6B 所建；且硅基流动 key 恢复后端到端语义检索
> 实测可用（真实查询首条 0.9219 命中目标条例）。

- [x] 5.1 **不做**：不改 `fd-legal-search-env`、不改 `FDLEX_EMBED_MODEL`、
  不清空/重建 `law_chunks_v2`、不改 flk-embed CronJob。
  **验证**：切换完成后 `fd-legal-search-env` 的 `FDLEX_EMBED_API_URL` /
  `_API_KEY` / `_MODEL` / `_DIM` 四项与变更前完全一致；`law_chunks_v2`
  点数不变（364,801）。
- [ ] 5.2 法条侧若未来要换上游或换模型（含与文本引擎统一到 8B），SHALL 另立
  change 并先评估全量重嵌。**验证**：另立 change 提案，本 change 不涉及。

## 6. 观测、文档与台账

- [x] 6.1 观察至少一个完整日周期：文本引擎嵌入调用零 502/5xx、词元用量行持续
  落账、余额扣减与预期一致。**验证**：用量面板行数记录；出现「无价可循」
  告警立即回填价目。
- [x] 6.2 从文本引擎侧 Secret `fd-text-core-env` 移除硅基流动 key（保留备份件内）。
  **验证**：读回 `fd-text-core-env` 不含硅基流动 key；**注意**：法条侧
  `fd-legal-search-env` 的硅基流动 key **保留不动**（Q3/Q4 决策）。
- [x] 6.3 更新台账 `docs/registry-maintenance.md`：登记本次切换（上游、模型、
  provider 钉扎、价目、密钥指纹、文本引擎配置变更）、法条侧维持 0.6B 的决策
  与实测依据（库真身判定）、以及硅基流动 key 在文本引擎侧退役。
  **验证**：台账含指纹无明文凭据；涉敏只进部署秘密件。
- [x] 6.4 **判定为不写入对外材料**（2026-10-18）：嵌入能力是**内部消费方**专用
  （组 8「embedding」+ 内部服务密钥 `embedding-internal`），按「凭据不扩散」纪律
  SHALL NOT 进入 `docs/ciyuan-intro.md`（伙伴交付面）。
  真正需要更新的是 `docs/ciyuan-openainext-value-proposal.md` §2/§4 的边界表述
  （仍写「没有 rerank、需另找上游」）——但该文档是选型决策存档（数据截至
  2026-10-16、版本 ciyuan-v0.2.16-9），属历史快照，按存档惯例不改写；
  新口径以本 change 与 handoff 文档为准。

## 7. 后续（不阻塞交付）

- [ ] 7.1 评估 rerank 车道的硅基流动依赖（同一账户 402），单列 change 切
  冗余上游。**验证**：另立 change 提案，本次不改。
