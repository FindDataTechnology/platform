# 词元 fork 谱系账本（FindDataTechnology/sub2api）

> 自 2026-10-14 起，萬星·词元以 **sub2api 增量谱系 fork** 形态运行（ADR-0024）：
> 月度合并窗跟上游 + 安全快车道 + 只增不改缝点纪律，与 registry 冻谱系（ADR-0017）
> 成对。本文件 = ①基线与发布记录 ②缝点登记表 ③月度窗台账（含 merge 用时记分）
> ④CI/出片挂账。操作手册：出片走 `tcr-image-pipeline` skill（law-ai-official 线）。

## 一、基线与发布记录

| 版本/tag | 基线 | 内容 | 验收 |
|---|---|---|---|
| `ciyuan-v0.2.19-4`（2026-11-11，**已上生产**） | `c589f0981`（分支 `feat/ciyuan-capabilities`） | **基线与稳定性端点** `GET /api/v1/keys/:id/stability?window=1h\|24h\|7d`（纯读）：`stability` = 成功率（**分母含失败**：成功取 `usage_logs`、失败/429 取 `ops_error_logs`；只用前者恒得 100%）+ p95（**仅成功请求**，失败 duration 会拉低 p95 造出假健康）+ 限流占比 + 活跃 UTC 小时 + 花费；`baseline` = 新 key 无历史 → 从 `(platform, model)` 类群体**中位数**继承，带 `source(population\|personal)` + `confidence(low\|medium\|high)` + 样本量，**低置信度不给数值**（小样本小数精度是编造）、无数据一律 `null`（非 1 非 0）。零迁移、零快照字段变更、不碰写路径 | **已出片上产**：源 `c589f0981` → 快照 `fa10b0a` → CI run `42940256108` test+build-push **双绿** → digest `7c8d53e2`（skopeo 实证 hkccr/ccr 一致）→ GitOps **gitee `8ecce69`**（本次按上笔教训**直接推 gitee**）→ rollout 绿、pod `sub2api-695b6cdd77-nqs4b` Running。**真机**：路由在位（无会话 401 vs 同前缀不存在路径 404 对照）；口径用库内同构 SQL 验算一致（key 168 近 24h：成功 5 / 失败 0 → ratio 1.0、p95 284305ms、$0.0253）。**说明**：该端点走**用户会话**鉴权（`GetAuthSubjectFromContext`），非 API key，故未做带会话的真机 200 验证——如实记录 |
| `ciyuan-v0.2.19-3`（2026-11-11，**已上生产**） | `dd816fd13`（分支 `feat/ciyuan-capabilities`） | **key 容量契约骨架（池 + 席位，add-key-capacity-contract 的 M1+M2）**：迁移 250 给 `api_keys` 加 `concurrency_request`/`concurrency_limit`/`rpm_limit`/`effective_at`（**纯追加、不做回填**）；认证快照 **v26→v27**；两级容量闸（池=`users.concurrency` 与该 key 硬顶，进程内原子计数 + 泄漏对账）；写路径三条不变量（`Σrequest ≤ 池` / `limit ≤ 池` / `request ≤ limit`）；`effective_at` 未到点 **403 `KEY_NOT_YET_EFFECTIVE`**（非 401）；新增 `GET /api/v1/keys/:id/state` | **已出片上产**：源 `dd816fd13` → 快照 `d3a4bf6` → CI run `42902676124` test+build-push **双绿** → digest `e669a139`（skopeo 实证 hkccr 与 ccr **一致**）→ GitOps **gitee `30620c7`** → `cheap-ts/sub2api` rollout 绿、pod `sub2api-59f7b79b6b-lgrmq` Running+Ready。**真机三证**：①迁移四列已建且默认值正确（`concurrency_limit/request/rpm_limit` 默认 0、`effective_at` 可空）；②**存量 123 把 key 全为默认**（nonzero_req/lim/rpm/eff 全 0）⇒ 闸恒放行，**行为零变化**；③能力快照真机返回容量段，且**"key 列 0 而 user 池 30" 时如实报 `effective_concurrency_limit=30` + `limit_source=user`**——「不许声称不限」这条判据在生产生效 |
| `ciyuan-v0.2.19-2`（2026-11-10，**已上生产**） | `5e3fc3b58`（分支 `feat/ciyuan-capabilities`，基于 main `ec4b1e478`） | **能力快照端点 `GET /v1/ciyuan/capabilities`（add-ciyuan-capability-endpoint）**：key-scoped 只读能力快照。`models.serving[]`＝可调度账号 `model_mapping` 并集（与 `/v1/models` 同源，`GetAvailableModels` 既有 30s 缓存）；`models.permitted_only[]`＝可见但无任何可调度账号能服务，带 `basis(allowlist\|platform_default)`——这正是今天「看得见、调不通」那一撮；`lanes.{rerank,audio,websearch}` 候选账号数；`media.image/batch_image/video`；`limits` 只给配置值。**未知一律 `null`**（池未装配 / 取数失败 / 无视频配置 / 窗口用量），`key_quota_usd=0` 用 `quota_unlimited` 消歧；空池 `false`+0 与取数失败 `null` 在契约层分开（首版混同被单测逮住）；`kind` 只标 `embedding`/`unknown`，不猜 chat/image/video；不含单价与倍率。**零迁移**（号段仍停在 249）、**零认证快照字段**（不动 `apiKeyAuthSnapshotVersion`）、**零计费路径**（不调 RecordUsage / 不 reserve / 不探测上游） | **已出片上产**：源真 sha `5e3fc3b58` → 快照 `05dd166`（`law-ai-official/sub2api-images`，`fd-build-snapshot` 走 git URL + `--ref`，可见性核对 private→private ✓）→ GHA run `42834400162` **test+build-push 双绿**（test job 用 go 1.27.3 跑 `go test -tags=unit ./...`；本地同样 59 包 ok / 0 FAIL）→ digest `8103c73a`（skopeo 实证 hkccr 与 ccr **一致**）→ GitOps `be8174e`（fd-infra-deploy `all-services/sub2api/01-sub2api-deployment.yaml`，一次 cherry-pick 到最新 `origin/main`；同仓另有并发会话的 `platform.yaml` 改动，**未纳入本提交**）→ `cheap-ts/sub2api` rollout 绿、pod `sub2api-78c794c79d-rrjls` Running+Ready 跑 `sha-05dd166`。**真机实证**（pod 内）：`/health` ok；`/v1/ciyuan/capabilities` 无 key → **401**，同前缀不存在的 `/v1/ciyuan/nonexistent` → **404**（路由确实挂上，且在 apiKeyAuth 链上）；用 `law-bench-ontology` key 调出完整 JSON——`counts{serving:101,permitted_only:0}`、三车道 `available:true` 各 1 个上游账号、`video.models:null`（分组无视频价目）、`quota_unlimited:true`、`window_usage:null`、**响应内无 `price`/`rate_multiplier`**（脚本断言通过） |
| `ciyuan-v0.2.19-1+guard`（2026-11-07，**已上生产**） | 当前 HEAD + `ec4b1e478` | **embedding 维度漂移守卫（模块优化战役 N-11）**：`openai_embeddings.go` 在读取上游响应后校验——请求带 `dimensions=N` 时每个向量必须 N 维、批次内长度必须一致；违规返回 plain error → handler 非 failover 路径 502、不写坏向量、不计费用量。`encoding_format=base64` 字符串与无 `data` 数组的错误形状不判。**契约口径同步**：paas `align-ciyuan-embedding-dimension`（f945d3702）把 spec 写死的 1024 改为「显式请求时截断；未传则取钉扎 provider 原生维度（生产 4096）」——唯一在产消费方 fd-memory 不传 dimensions，照旧 1024 硬编码会打断记忆链。夹具自洽修正（既有两处 mock 返回 2 维却声明 256/1024，守卫上线必红），6 例表测 + 转发级负例，**service 包 142s 全绿** | **已出片上产**：出片=`law-ai-official/sub2api-images` 专用快照线 `sha-9211d4a`（run 42319121274 绿，target 核对=finddata/sub2api）→ relay 08:53 OK → ccr digest b2eda537（skopeo --creds 实证）→ GitOps `c10f043`（fd-infra-deploy，ns **sub2api** 非 fd-prod）→ rollout 绿；**生产实证**：pod 内 `/app/sub2api` 时间戳 2026-11-07 08:50（本次构建）、`strings` 命中守卫文案 1 次=代码在位、8080 端口 HTTP 栈应答。**事故在案（本窗实锤两次）**：①`testaction002/build-pool` 首推后 `BUILD_IMAGE` 被并发会话覆写成 `fd-cn-report`，我的 sub2api 代码被构建成 `fd-cn-report:sha-3c8580f`（弃用，勿引用）；②换 `testaction003/build-pool` 后该池残留 `BUILD_CONTEXT=server`/`finddata-business` 并跑了 `api-test` job → 失败。**结论：sub2api 出片必须走专用线 law-ai-official/sub2api-images，共享池的 `--dockerfile/--context` 四变量钉死在推送后被并发会话覆写，不可靠。** |
| `ciyuan-v0.2.16-16`（2026-10-29，**已上生产**） | 上游 v0.2.16，fork 补丁级 16 | **embedding 后台可见/可配三件**：①**模型目录**——聚合渠道 `/v1/models` **不列 embedding**（OpenRouter 实测 421 条零个），而后台两处读面只认「上游目录 ∪ `openai.DefaultModelIDs()`（全是 gpt-5.x/gpt-image）」→ 纯 embedding 账号的「账号可用模型」恒空、分组白名单候选选不到 embedding，手写 `credentials.model_mapping` 也救不了（投影要求目标在上游目录）。修=新增 `service/embedding_model_catalog.go` 静态目录（只列本部署实际承载过流量的 4 个模型）+ `WithEmbeddingModelsForPicker` / `withEmbeddingModels` 在两处读面**只追加**（既有条目顺序零改动，有测试钉住）。②**细分渠道钉扎可视化**——v-12 的账号级 `extra.embedding_provider_only` 后端一直认但**前端无入口**，运维看不见当前钉哪家也改不了，只能 SQL。修=编辑账号弹窗新增区块（下拉 Nebius/SiliconFlow/DeepInfra/未钉扎，载入回填、保存写回、空=删键，合并基准取账号现有 extra 而非 payload 以免抹掉其它键）+ 提示写明「换渠道=换向量空间，切换后必须重建历史向量」。③**恒空真根因（本班修）**——①②仍不够：`GetAvailableModels` 先走 `FetchOpenAIAccountModels`（上游目录 → `projectAccountModelsBody` 按 mapping 投影，目标不在 byID 即丢弃）→ 投影结果**空数组且 err==nil**，handler 成功分支直接短路，连①的回落都走不到（生产实证账号 47 返回 `{"code":0,"data":[]}`）。修=在 `FetchOpenAIAccountModels` **出口**补 `WithEmbeddingModelsFromMapping`：只把账号 mapping 里 `IsEmbeddingModelID` 命中、且被投影丢掉的行补回 picker；chat 模型仍「上游没列就不展示」，未声明 embedding 的账号零变化 | fork `4c48d27c9`（源 `99942a69c` 修复 + 三提交前序）；单测 embedding_model_catalog 6→9（新增生产形态回归：上游 2 条 chat + mapping 只有 Qwen3-Embedding-8B → 恰好 1 条 embedding；非 embedding mapping 不合成；通配符跳过+去重+稳定序），service 139s 绿、admin 绿；出片=testaction005/build-pool `sha-2faf622`（run 40791130108 绿，target `finddata/sub2api`）；GitOps `e68ccec`（fd-infra-deploy）滚产；**生产验收六证**：①`GET /admin/accounts/47/models` 由 `data:[]` → `[{"id":"Qwen/Qwen3-Embedding-8B"}]`；②分组 8/12 的 `model-allowlist-candidates` 各见 4 个 embedding 模型；③账号详情回读 `extra.embedding_provider_only=Nebius`；④UI 编辑弹窗钉扎下拉眼见（四选项齐全、回填 Nebius、黄色警告文案在产），同弹窗模型区显示 `Qwen/Qwen3-Embedding-8B`；⑤UI 点 Update 保存后 8 个 extra 键**一个不丢**（含 `duplicate_operation_id`）——前端合并基准正确；⑥**向量一致性实证**：钉扎 Nebius 下同文本连调 3 次 `cos=1.000000000`，批量组(key143)/交互组(key131) 跨车道 `cos=1.000000000`，维度 4096 稳定。**坑在案**：①ArgoCD `sub2api` 应用 health 绿但 `OutOfSync` 时 `kubectl set image` 会在 78s 内被 selfHeal 回滚——**这一面必须走 GitOps**（`fd-infra-deploy/all-services/sub2api/01-sub2api-deployment.yaml`）；②直连 PUT `{extra:{单键}}` 是**整对象替换**（只回填系统受管白名单），会抹掉 `duplicate_operation_id`/`openai_responses_supported`/ws 开关——前端无此问题（以账号现有 extra 为底），**裸 curl 验收禁用单键 PUT**；③build-pool 的 `BUILD_NAMESPACE` 曾残留 `yizuo` 致镜像推到 `yizuo/sub2api`（relay 只认 `finddata/sub2api`，不携带），出片前须核 target 行 |
| `ciyuan-v0.2.16-8`（2026-10-16） | 上游 v0.2.16，fork 补丁级 8 | **「模型车道」页白屏修复（并行会话）**：/lanes 卡片文案 `lanes.shapes.*` 三条（zh/en 共 6）内嵌未转义花括号 → vue-i18n 运行时编译抛 Unterminated closing brace，组件树整体卸载（BODY len:0）；修=字面量转义 `{'{'}` + `localesMessageCompile.spec.ts` 入 Makefile FRONTEND_CRITICAL_VITEST（能抓该类缺陷的守测此前不在关键清单=漏网根因） | 并行会话随 v-9 出片一并滚产（62ab82d28） |
| `ciyuan-v0.2.16-15`（2026-10-19，**已上生产**） | 上游 v0.2.16，fork 补丁级 15 | **TTS 两处真缺陷修复**（生产实证：`/v1/audio/speech` 自 10-19 01:49 起零次 200）：①**采样率跨平台误用**——调用者不传 `sample_rate` 时车道取豆包默认 24000 并原样传给腾讯云，`VoiceType=101007` 不支持 24000 回 `InvalidParameterValue.SampleRate`，腾讯 TTS 100% 失败；改为「未指定时各协议适配器取自身默认」（腾讯 16000），并加「音色不支持该采样率则降级回退 16000 重试一次」。②**上游业务错误码被吞**——云 API 业务错误常以 HTTP 200 + `Response.Error` 返回，原实现把 status=200 原样下发，冷却原因写成 `status 200`（无判别力）、真实码只在 bodyExcerpt 里日志看不到；改为按业务码归类到 400/401/403/429/502，并把 code+message 写 WARN。**附带修**：`firstN` 原只定义在 `_test` 文件、生产构建（不含测试文件）undefined 致 CI 红，移入 `errors.go` | 出片=testaction004/build-pool `sha-ef14f6e`（源 57616e6c9，run 39166919214 绿，digest 3792f43c）；GitOps 8f676a6 滚产（pod imageID=3792f43c 逐字节一致）；**生产验收**：`/v1/audio/speech` 200/11376B 合法 mp3（MPEG layer III 32kbps **16kHz**，即修复后的采样率）、ASR 回灌识别「TTS修复后验收成功。」、用量行 113751=`tencent:101007`；`node scripts/verify-live-voice.mjs` **ALL PASS**（TTS 独立探针 9648B 真载荷、计费到用户 key、播放态、断连回落部署 key）。**测量陷阱**：Playwright `waitForResponse.body()` 在页面已 `res.blob()` 消费响应后读到 0B，是假失败——真载荷须独立打一次端点量字节 |
| `ciyuan-v0.2.16-11`（2026-10-18，**已上生产**） | 上游 v0.2.16，fork 补丁级 11 | **audio 车道跨协议上游（audio-lane-multi-upstream）**：既有 audio 只支持 OpenAI 兼容 HTTP，生产唯一 audio 账号（#38）自 04:16 起 429→连接失败，车道整体不可用。本次把「上游协议」从适配器内部假设提升为**账号级标注**（`credentials.audio_protocol`: openai\|doubao\|tencent，缺省回落 openai，既有行为逐字节不变），两个 failover 回调按候选账号分派。①**豆包 openspeech**：TTS=WebSocket 双向流 + V3 二进制帧（实测确证：首字节高/低半字节=版本/header size、event 必须 int32、session 类帧带 len+sid 段、Audio-only 帧带 payload size 且 serialization=0 裸二进制、2.0 音色须 `*_uranus_bigtts`）；ASR=异步任务 submit+query 轮询（上限 120s），上游只收公网 URL 故加 `audio_spool`（账号级 `audio_public_base_url` 优先、环境变量兜底、TTL 惰性清扫、未配置则**明确报错不静默降级**）。②**腾讯云云 API 3.0**：TC3-HMAC-SHA256 自签 + `TextToVoice`（Base64 解码后下发）+ 一句话识别（同步收字节）。③计量沿用既有 Group 音频三价（TTS 百万字符 / STT 小时），**零新增价目字段** | 出片=testaction004/build-pool `sha-8c0f4f8`（源 3373eae6f，CI run 39132310921 绿，digest bbca6ec9）；GitOps f7fe24a 滚产（pod imageID digest=bbca6ec9 逐字节一致）；**生产验收全绿**：`POST /v1/audio/speech` 200/27885B 合法 mp3（ID3 v2.4+MPEG layer III 64kbps 24kHz）、`POST /v1/audio/transcriptions` 200 且转写文本正确；**用量行实证归因**（106331/106337=豆包 TTS、106332=腾讯 ASR）；单测 30+ 全绿（帧金样取自真机抓包）、既有 lanes 套件零回归；**真机 LIVE 测试**（env 门控，不烧 CI）：豆包 TTS 25965B、豆包 ASR 405 字符/33.621s、腾讯 TTS 15408B/17 字符、腾讯合成→识别闭环「腾讯云语音识别测试成功。」。**生产实测抓出两缺陷已修**（2434d7ac9）：spool 配置缺失被误记 `misconfigured` → 账号错误长冷却 12h 且 admin 显示「account missing credentials」（实为部署配置缺失，改瞬态）；`SensitiveCredentialKeys` 漏 `secret_id`/`secret_key` → 腾讯云凭据明文回显 admin API。**已知缺口**：ASR 走豆包需部署侧提供公网可达音频前缀（现未配，腾讯云路径不受影响） |
| `ciyuan-v0.2.16-9`（2026-10-16） | 上游 v0.2.16，fork 补丁级 9 | **车道平台建号缝（账户管理 UI 可选车道上游）+Seedance 引导文案**：车道三家（siliconflow/serpapi/openainext）自 v-2 登记平台清单（Gateway=lane）但创建账户弹窗只渲染硬编码行+multi_protocol 行 → 无处可选、车道账号只能 admin API。修=①平台选择器新增车道行（`platform-row-lanes`，**读清单 gateway=lane 不硬编码**，后续登记即出现）；②凭据只写 `api_key`，base_url 留空不写键（车道网关按平台走内置端点）；③**五坑修复**：创建 defaultBaseUrl 兜底链落 anthropic 脏值/平台切换 watcher 覆写/编辑装载无值预填/编辑保存无条件回写/编辑 defaultBaseUrl 兜底——lane 分支全链贯通；④**根上第五坑**：`getModelsByPlatform` 无 profile 未知平台回落 claudeModels → 白名单 watcher 把整份 Claude 清单写成恒等 model_mapping（车道账号应不限模型，与多协议聚合同待遇回落空）；⑤文案：endpointCapabilitiesDesc 补 Seedance 需 base_url 指向视频上游端点（如 `https://api.openai-next.com/seedance`），车道行带用途说明（laneProviders.* zh/en 对称）；⑥base_url 输入框补 testid（api-key-base-url/edit-base-url） | fork 8b6422c4c（tag bump 012ca46e2）；目标 spec 147/147+邻近 69/69+check:i18n 3/3+vue-tsc 零错误；出片=testaction004/build-pool `sha-8beeb09`（CI run 38786413969）；GitOps c3fce3c 滚产（pod imageID digest=db6d631c 逐字节一致，ArgoCD sync Succeeded）；**生产验收全绿**：/health 200+admin API 建 serpapi 探针账号（payload 仅 `api_key`，落库无 base_url，列表回读正确，测毕删除）；UI 眼见两项=①创建弹窗车道行（SiliconFlow/SerpAPI/OpenAI-Next）可选，选中 SerpAPI 后 base_url 输入框为空、车道用途提示句可见；②OpenAI 平台 Endpoint capabilities 处 **Seedance 引导句眼见**（"Checking Seedance requires a video upstream endpoint in the Base URL above (e.g. https://api.openai-next.com/seedance)…"，zh/en 双语均在产） |
| `ciyuan-v0.2.16-12`（2026-10-18，**已上生产**） | 上游 v0.2.16，fork 补丁级 12（与 v-11 音频车道同源镜像） | **embeddings 账号级 provider 钉扎**：聚合渠道（OpenRouter）对同一模型 slug 挂多个 provider，各家量化/实现不同 → 同文本连调 10 次向量漂移（不钉扎 min_cos=**0.996511**；钉 Nebius **0.999925** 过门；钉 DeepInfra **0.997614** 不过门）。比「质量稍差」严重：库内向量与查询向量可能来自不同空间，检索静默漂移且无人能发现。修=新增账号级配置位 `extra.embedding_provider_only`（逗号分隔），在 `ForwardEmbeddings` 构造 upstreamBody 时注入/覆盖请求体 `provider` 选择器；调用方自带值被覆盖（防绕过），未配置/空串/nil 则不改写 body（零行为变化）。沿用 `grok_media_eligible` 既有范式（validate + normalize + update 分支） | fork 40f03b1b2；新增 4 例单测（注入/覆盖/未配置零变化/配置位校验）+ 既有 embedding 测试全绿，service 包（139s）与 handler 包（41s）全量 PASS；出片=testaction004/build-pool `sha-8c0f4f8`（源 3373eae6f，含 v-11；run 39131983126 绿）；GitOps f7fe24a 滚产（pod imageID digest=**bbca6ec9…** 与 ccr skopeo 读数逐字节一致）；**生产验收三证**：①请求体**不带** provider 调嵌入得 200/1024 维；②**反证**——临时把钉扎改为 `NoSuchProviderXYZ`，上游即回 `No allowed providers are available … Providers serving qwen/qwen3-embedding-8b: nebius, siliconflow, deepinfra`（证明确由网关注入而非透传）；③恢复 Nebius 后生产 10 次连调 **min_cos=0.999905** 过门。**坑在案**：build-pool 仓 `BUILD_NAMESPACE` 是共享变量，被并发使用者改成 `sub2api` 时推送会被 `denied: no permission`（本次首个 run 39131350681 因此红，非代码缺陷）；出片前须核 run 的 `target:` 行是否为 `finddata/sub2api |
| `ciyuan-v0.2.16-7`（2026-10-15，**已上生产=当前终态**） | 上游 v0.2.16，fork 补丁级 7 | **调度投影保留 openai_capabilities——Seedance 视频账号被恒久排除修复**：`filterSchedulerCredentials` 白名单漏 `credentials["openai_capabilities"]`，候选过滤 `capability_mismatch` 读投影 → 配了 seedance 能力的账号每请求被滤（`seedance_no_eligible_account`）；`sched:acc` 全量快照有、`sched:meta` 投影无=生产实证「时好时坏」形态（投影缺失时 DB 回退才可用）。上游原生缺陷（与 upstream/main 逐字节同源；同类已修三次：RPM/passthrough/Anthropic 阈值）。修复=白名单补键（常量导出 `OpenAIEndpointCapabilitiesCredentialKey`）+双回归测试（直测+marshal 往返）。**附带打通 openai-next Seedance 视频通道**：账号 #40（base_url=`https://api.openai-next.com/seedance`，能力=seedance-only）绑组 9，端点前缀 `/seedance/api/v3/contents/generations/tasks`（官方文档埋在 JS chunk 里）；**组 9 model_pricing 四型 seedance 成本恢复价**（=$2/MTok×上游 ratio，fast $9.25/MTok；实测 87300tok→$0.8075 分毫不差） | 出片=testaction004/build-pool `sha-893f610`（源 e8794277f，CI run 38735600155 test+build 绿）；cheap3 skopeo 补打语义 tag；GitOps dc56ded 滚产（含并行会话 OIDC 修复 sha-678937c 前滚安全=ancestor 校验）；**生产验收六件全绿**：创建 200/轮询 succeeded/720p mp4 下载 2.27MB/连发稳定（投影热态）/seedance-2-5 亦通/计费行 95862→95915 $0→$0.8075 对账✓；教训在册：**调度投影白名单是隐蔽裁剪面**（`sched:meta` 是候选过滤真源，DB 与 `sched:acc` 正确≠调度正确）；doubao-seedance-1-0-pro 上游 503（openai-next 侧，与本修复无关）；sora-2/veo3/kling 等模型目录挂着但 openai-next 无对应路径（404） |
| `ciyuan-v0.2.16-6`（2026-10-15） | 上游 v0.2.16，fork 补丁级 6 | **BYOK 用量行外键修复**：v-5 线上实证——BYOK 笔合成的 `Account{ID:0}` 被 `usage_logs_account_id_fkey` 拒（NOT NULL+FK），归因行静默丢失（HTTP 200/零费均正常但"计量入账"没达成）；修=账号位锚定池首号（归因真相仍在 `UpstreamModel=byok:<hash8>` 前缀，费率 0 故账号侧统计零影响） | 出片=build-pool `sha-3431400`（源 5893e0e88，CI run 38640404216 test 4m52s+build 全绿）；GitOps 7b1ce01 滚产；**真回路验收全绿（用保存的 SerpAPI key 新 key+耗尽旧 key）**：①池路径 200 `x-search-source: pool`+用量行 $0.02 归因 acct 37；②BYOK 成功 `source: user`+**用量行 93735 `byok:55faa0c2` 0 费落地**；③BYOK 坏 key `pool-after-user-failure` 回退正常计费；④**轮转实证**（临时插耗尽旧 key 账号 #39 priority=0 → 请求 200 由 #37 完成，坏号落 12h 冷却 `temp_unschedulable_reason=lane websearch upstream quota/auth failure (status 429)`，探针账号测毕即删） |
| `ciyuan-v0.2.16-5`（2026-10-15） | 上游 v0.2.16，fork 补丁级 5 | **车道池 v1.1（ciyuan-lane-pool-failover）**：①`Pick`→`Candidates` 全候选轮转——单账号失败分级冷却（额度/auth 类 12h、瞬态 60s，判据对齐 search-relay `isExhausting`，裸 429 落瞬态）+换下一候选，全池尽才 5xx；冷却复用上游 `SetTempUnschedulable` 落 DB（跨重启+admin 可见，**零新增缝点**——池本就持完整 AccountRepository）；②websearch BYOK：`X-Serpapi-Key` 请求级覆盖，用户 key 优先（端点=首候选 base_url）/失败按 hash8 冷却回退池/`x-search-source` 三态如实标注；BYOK 笔计量保留 0 费（`UpstreamModel=byok:<hash8>` 归因，成本分支挂缝点「分组价目」rerank 同位先例）；③400/422 终态不换号；misconfigured 账号长冷却换号 | 出片=build-pool `sha-21106d0`；**测试门搬家**：law-ai 额度实尽（320min 读数滞后，5s payments-failed 实证）→ build-pool workflow 补 test job（钉 go 1.27.0，test 9m37s 全绿含新 failover/BYOK 用例 + build-push + Smoke boot）；坑：池 tag 跟 build-pool HEAD 走/`cancel-in-progress` 并发组吃在途 run/语义 tag 用 cheap3 skopeo 补打；GitOps 4eb53fd 滚产；探针全过（version 自报 v0.2.16-5、鉴权链统一 401、零 panic） |
| `ciyuan-v0.2.16-4`（2026-10-14） | 上游 v0.2.16，fork 补丁级 4 | **①rerank 计 0 真根因修复**：`GetByKeyForAuth` ent 显式 Select 白名单补 `FieldRerankPricePerRequest`（v0.2.16-3 的快照升版是防御性修复，真凶是查询不取该列——DB 有值 Group 恒 nil）；**②audio 上游拆分**：新平台 `openainext`（Gateway=lane）——运营分工 rerank=硅基、audio/image/video=openai-next（LanePlatform/LaneEngine 拆分+金样七面镜像） | 出片=build-pool 池 `sha-8dc08e1`（law-ai 额度尽后首次启用备胎）；GitOps 35472f6→aebed9b 滚产；三车道终态复验（全绿）：rerank 92761 $0.004 分毫不差（acct 36 硅基）+TTS 92762 $6e-05（acct 38 openai-next）+ASR 200（whisper-1 $4.17e-05）+websearch 93518 $0.02 分毫不差（acct 37 SerpAPI 新 key）；教训：ent 显式 Select 加字段必须同点补列、池出片 tag 语义、Smoke gate 不吃逗号多 tag（SEMTAG 拆变量） |
| `ciyuan-v0.2.16-3`（2026-10-14，**已上生产**） | 上游 v0.2.16，fork 补丁级 3 | **快照版本门禁修复**：`apiKeyAuthSnapshotVersion` 24→25——v0.2.16-2 给 `APIKeyAuthSnapshot` 加 `rerank_price_per_request` 未升版本号，滚产窗口内 Redis L2 存量 v24 快照按旧形状反序列化 → 组价目 0.004 配着仍计 0（实证=用量行 92221 打 `price_missing_bill_zero`，同批 audio 正确=恰逢缓存重建） | 出片=`sha-df55f02`（CI 一次过 run 38563976508）；GitOps a12238d 滚产；version 自报 `ciyuan-v0.2.16-3`+/health 200+零 panic；**rerank 真回执已收**（硅基官方 200，结果形状 index/relevance_score 正确——用量行 92221 计 0 系本 bug，修复后等**硅基账户充值**（现 402 balance insufficient）补复验笔对账 $0.004）；教训入 runbook §3 |
| `ciyuan-v0.2.16-2`（2026-10-14，**已上生产**） | 上游 **v0.2.16**（01842576b），fork 补丁级 2 | **三车道 v1 首发**：rerank（硅基形状/按请求/新价目字段全链）+ audio（ASR/TTS，复用分组音频三价）+ websearch（自有统一信封/按次）+ 统一错误面（lane+engine 标识/不外泄/不计费）+ 车道入口页 /lanes + 车道上游平台登记（siliconflow/serpapi，Gateway=lane） | 出片=law-ai 快照 `sha-4310880`（fork ecb84e395，CI test+build 全绿）；**生产验收**：GitOps 滚产（2560673）+/health 200+版本端点自报 `ciyuan-v0.2.16-2`+零 panic；**车道上游账号**：#36 硅基官方（用户供 key）/ #37 SerpAPI（search-relay 同源）；**分组价目（组 3）**：rerank $0.004/次、websearch $0.02/次、STT $0.15/h、TTS $15/百万字符；**真回执**：audio ASR 200（$0.15/h×1s=4.17e-05 对账✓ 用量行 92162）+TTS 200（qwen3-tts-flash+Cherry，65KB WAV，修正价后 15/M×5 字符=7.5e-05✓ 用量行 92170）+rerank 200（硅基官方接入后，见 v-3 行）+websearch 链路通（上游 429 归因=SerpAPI 月额度尽）；**入口页已部署**（LanesView chunk+i18n 在生产 bundle）；**挂账**：websearch 真回执（SerpAPI key 月额度尽——等新 key，直连/经链路均 429）；**教训在册**：TTS 价目单位=每百万字符（配 15000 是 1000 倍错，行业口径 $15/M）；ArgoCD sync 假绿须先 annotate refresh 看 revision 变更再 sync |

**版本语义**：`ciyuan-vX.Y.Z-N` = 已并入上游 vX.Y.Z + fork 补丁级 N（ADR-0024）。
**首窗即还欠账**：生产 sub2api 自 0.2.7 直升本基线。

## 二、缝点登记表（只增不改纪律）

fork 自有代码全在 `backend/internal/lanes/` 等新增包；上游文件仅允许触碰下列
登记缝点。缝点集合变更须显式登记。**基线仍零补丁**（`git diff upstream/v0.2.16` 为空）；
下表=2.1 摸定集合（2026-10-14，全部 file:line 实证），实际触碰自 §2.2 车道骨架起。

| 缝点 | 位置（v0.2.16 实证） | 用途 |
|---|---|---|
| 路由注册 | `backend/internal/server/routes/gateway.go:184-187`（`/v1` 组挂 apiKeyAuth） | 车道路由 `/v1/audio/*`、`/v1/rerank`、`/v1/search` 挂 `KeyBillingInfo` 同位（组门 groupModelAllowlist **之前**——车道不绑 chat 分组语义）。非 chat 同位先例：`/v1/sub2api/billing`、`/v1/live`、`/v1/custom-voices/:id/audio`、GrokRealtime WS。**注意：该文件有 400 字符源码级断言窗口**（gateway_model_allowlist_test.go 校验 auth→allowlist 挂载间距）——缝点插入窗口内只留一行，Meter 构造挪组创建之前 |
| handler 服务访问器 | `backend/internal/handler/openai_gateway_handler.go` 文件尾（+10 行只读 getter） | `LanesBillingCacheService()`/`LanesGatewayService()`——车道计量取计费准入与原生账本写入服务；不走 wire 重排装配（BatchImage 式注入先例） |
| 计量-账本写入钩子 | `backend/internal/handler/openai_alpha_search.go:275`（recordAlphaSearchUsage→`submitMandatoryUsageRecordTask` 池提交+池满同步兜底→`GatewayService.RecordUsage`） | 车道按次/按量计费落原生用量行的**完整参考实现**（扣费不丢） |
| 媒体价目面（分组） | `backend/internal/service/media_price_config.go` + Group 字段（admin 后台 admin_group.go 可配） | 上游已有：WebSearchPricePerCall、SearchPricePer1k、Image 1K/2K/4K、Video 480/720/1080、**AudioRealtimePerMin/TTS每百万字符/STT每小时**——websearch+audio 车道直接复用；**rerank 唯一需新增价目字段**。按次计算先例 `CalculateWebSearchCost`（openai_gateway_usage.go:594-599=单价×组倍率） |
| 音频计量机器 | `service.AudioUsage{Mode,DurationOrUnits}` + `reserveInflightBalance(Kind=InflightEstimateAudio)`（handler/grok_audio.go:47） | audio 车道 ASR/TTS 计量复用 Mode 形状，零新机器 |
| 余额/窗口前置检查 | `billingCacheService.CheckBillingEligibility`（grok_audio.go:36 同款） | 车道请求前置：窗口耗尽拒付不触上游 |
| 平台清单（**已触碰**） | `backend/internal/domain/platforms.go`（+Gateway=lane 枚举+siliconflow/serpapi 两行）+ `platforms_test.go`（期望清单同步，上游既定「按位补入」模式） | 车道上游=真 Account 行（2.4）：admin 账号管理面下拉即达；登记副作用=平台进「所有平台」类列表（含分组下拉——误建 chat 分组属可恢复误配，单管理员风险受控）；Gateway=lane 使 UsesOpenAIGateway 等谓词恒 false |
| service 账号仓储访问器 | `backend/internal/service/openai_gateway_service.go` 文件尾（+1 只读 getter） | `LanesAccountRepo()`——车道池取数（ListSchedulableByPlatform）；与 handler 访问器同注入模式 |
| 车道平台谓词排除 | `backend/internal/service/scheduler_snapshot_service.go`（schedulerSnapshotPlatforms）+ `upstream_billing_probe.go`（IsUpstreamBillingProbeIdentity） | Gateway=lane 平台**不进** chat 调度快照（空桶白耗内存，inflight 8MB 界 CI 实证越线）**不进**上游计费探测（非 chat 上游，不外发 key） |
| 调度投影凭据白名单 | `backend/internal/repository/scheduler_cache.go`（filterSchedulerCredentials）+ `service/account.go`（常量导出） | 候选过滤按 `credentials["openai_capabilities"]` 判能力（capability_mismatch），投影白名单漏该键 → 配了能力的账号被恒久排除（v0.2.16-7 修复；上游同类既有修三次：RPM/passthrough/Anthropic 阈值） |
| 分组价目（rerank） | `ent/schema/group.go`+迁移 246+repo/auth 缓存/admin DTO·输入·克隆/`billing_service.go`（CalculateRerankCost）/`openai_gateway_usage.go`（成本分支） | `rerank_price_per_request`（USD/请求，nil=0 计费告警）——镜像 web_search_price_per_call 全链模式；本 change 唯一 schema 变更 |
| 测试阈值 | `billing_inflight_reservation_test.go`（8MB→9MB） | 车道平台+价目字段合法增重（CI 1.27.0 实测 8587240）；防失控守护本意不变 |
| embedding 模型目录（**新增**，ciyuan-v0.2.16-16） | 新增 `backend/internal/service/embedding_model_catalog.go`（+ `_test.go`）；触碰三处：`service/admin_group.go`（defaultModelsListCandidateIDs 的 OpenAI 分支）、`handler/admin/account_handler.go`（GetAvailableModels 无 mapping 的默认分支）、`service/account_test_service.go`（**FetchOpenAIAccountModels 出口**——`WithEmbeddingModelsFromMapping`） | 聚合渠道 `/v1/models` 不列 embedding，读面只认「上游目录 ∪ DefaultModelIDs()」→ 纯 embedding 账号在后台模型列表恒空、分组白名单选不到、mapping 也因 byID 缺失被丢弃。更隐蔽的是**短路**：`GetAvailableModels` 先走 `FetchOpenAIAccountModels`，那条路投影后**空数组且 err==nil**，handler 直接 `response.Success` 返回，静态目录回落永远走不到（生产实证 `{"code":0,"data":[]}`）。修=静态目录**只追加**（既有条目零改动，有测试钉住）+ 出口按账号 mapping 补回被投影丢掉的 embedding 行（判据 `IsEmbeddingModelID(公开名‖目标)`，chat 仍「上游没列就不显示」）。仅影响后台可见/可配置性，不改路由/转发/准入 |
| 账号钉扎 UI（**新增**，ciyuan-v0.2.16-16） | `frontend/src/components/account/EditAccountModal.vue`（钉扎区块：下拉+回填+保存写回，空=删键）+ `composables/useModelWhitelist.ts`（openai 清单补 embedding）+ `i18n/locales/{zh,en}/admin/accounts.ts` | v-12 的 `extra.embedding_provider_only` 后端一直认但前端无入口（只能 SQL）。**合并基准必须取「账号现有 extra」而非 payload**——后端 PUT extra 是整对象替换、只回填系统受管白名单，用 payload 做底会抹掉 `duplicate_operation_id`/能力位/ws 开关 |
| embeddings 转发路径（**新增**） | `backend/internal/service/openai_embeddings.go`（+1 行调用 `applyEmbeddingProviderPin` +1 条 debug 日志字段）+ 新增 `account_embedding_provider_pin.go`（配置位常量/校验/解析/注入）+ `admin_account.go`（create/update 两处 normalize 接入，沿用 grok_media_eligible 范式） | 「只增」：仅作用于 embeddings 请求体构造，其它端点零影响；未配置时 body 不改写 |
| 前端路由+导航 | `frontend/src/router/index.ts` + `components/layout/AppSidebar.vue` | 车道页路由（/lanes）+侧边导航入口「模型车道」（5.2） |
| i18n 词条 | `frontend/src/i18n/locales/lanes.ts` + zh/en index 装配 | 车道页/导航词条（zh/en 对称；扁平化命名空间避免与 common.nav 顶层冲突） |
| OIDC 多宿主回调派生 | `backend/internal/config/config.go`（`OIDCConnectConfig.RedirectURLAliases` 字段 + `setDefaults` 一行）+ `backend/internal/handler/auth_oidc_oauth.go`（`oidcRedirectURLForRequest`/`oidcRequestHost`/`oidcHostWithoutPort`，Start 与 Callback 两处取址改调） | **fix-ciyuan-oidc-login**：token./router. 两域同部署服务，而回调单值 + state cookie host-only → router 域登录必然 `invalid_state`（实测）。按请求有效主机（X-Forwarded-Host 优先、去端口）命中**别名白名单**时返回该别名 URI 原文（与 Logto 登记逐字节一致），未命中回落单值；白名单防 Host 头伪造外泄授权码。零 schema、零对外契约变化 |
| 有界排队+AIMD（**新增**，add-sub2api-fork-concurrency 2.1-2.3） | 新增 `backend/internal/repository/account_queue.go`（+`_test.go` 7 件）；接线两处：`repository/http_upstream.go`（Do 入口 acquireAccountSlot/出口 release+AIMD 记账）+ `service/openai_account_runtime_block_fastpath.go`（语义失败喂点）；port `service/http_upstream_port.go`（RecordAIMDResult）；映射 `service/openai_upstream_transport_error.go`（ErrQueueFull/Tripped→429 终止性）+ `handler/openai_gateway_handler.go`（mapUpstreamError 429 透出）；观测 `handler/admin/account_handler.go`（GetUpstreamQueueMetrics）+ `server/routes/admin.go` | 病根=MaxConnsPerHost 饱和后 transport 内部队列**无界等待**（1.1s 坏仓库 403 拖死整池，10-27 词元配额事故同族）。修=进 transport 前过 per-account 信号量：bound=账号 Concurrency（缺省 env UPSTREAM_CONCURRENCY_MAX=8）、队列深 UPSTREAM_QUEUE_BOUND=bound×4、队满/熔开 429 快速拒（NextAccountStop 不推压力下一账号）；AIMD：5xx 三连减半下限 1、429 容量信号收窄不计连击、成功冷却 +1 恢复，UPSTREAM_AIMD_ENABLED=false 一键静态；观测面 GET /admin/accounts/upstream-queue-metrics（queue_depth/queue_rejected_total/aimd_concurrency + aimd_state open|half_open|closed 真状态）。**等待用唤醒式（cap1 通知+兜底轮询）——首版纯轮询在 8 等待者下不收敛（单测逮住）**。零 schema、零对外契约变化；port 全部 test fake 补 no-op |
| 车道平台建号缝（前端） | `frontend/src/constants/platformCatalog.ts`（PlatformGateway +'lane' 枚举、isLanePlatform 谓词）+ `components/account/CreateAccountModal.vue`（平台选择器车道行+selectLanePlatform+凭据构建 lane 分支）+ `components/account/EditAccountModal.vue`（装载/保存 lane 分支）+ `composables/useModelWhitelist.ts`（getModelsByPlatform 默认分支 lane 回落空）+ zh/en admin/accounts.ts（laneProviders.*） | **ciyuan-v0.2.16-9**：车道上游账号在管理台 UI 建/改（此前只能 admin API）；base_url 留空=内置端点语义全链贯通（创建/编辑/白名单回填五坑修复）；前端读清单 gateway=lane，后续新车道平台登记即自动出现 |
| 能力快照模型源（**新增**，add-ciyuan-capability-endpoint） | 新增 `backend/internal/handler/lanes_capability_models.go`（`*GatewayHandler.LanesCapabilityModels`：返回「可调度账号可用模型」+「与 /v1/models 同源的可见模型源」）；接线一处：`server/routes/gateway.go` 的 `lanes.NewFromOpenAIHandler(...)` 多传一个方法值（同一行，不新增挂载点）。**路由本身不碰上游文件**：`group.GET("/ciyuan/capabilities", …)` 加在 `internal/lanes/router.go` 的 `RegisterGatewayLanes` 内，复用已登记的「路由注册」缝点 | **为什么需要新文件**：`GetAvailableModels` / `compositeAvailableModels` / `modelListingSource` / `defaultModelIDsForPlatform` 都在 `GatewayService`（`h.Gateway`）与 handler 私有作用域，`OpenAIGatewayHandler` 只持有 `OpenAIGatewayService`（无模型列表能力）。若在 `lanes` 里重写一遍映射并集（passthrough 跳过、mixed scheduling 豁免、Anthropic 默认目录合并），能力快照与 `/v1/models` 必然漂移成两个口径。新文件 + 一个方法值 = 零逻辑重复，先例同 `embedding_model_catalog.go`（同为新增文件）。零 schema、零认证快照字段（**不动 `apiKeyAuthSnapshotVersion`**）、零计费路径 |

**首笔缝点触碰（2026-10-14，未发版）**：车道骨架+计量通道+上游账号池+**§3 三车道
v1 全落地+故障口径统一**+**§5.2 车道入口页**（rerank 3.1 / audio 3.2 / websearch 3.3 /
统一错误面 3.4 / 前端 /lanes）落 `internal/lanes/` + 前端登记缝点（fork commits
9225e8baf→ee7f32bcf 已推 main）；**CI 全绿实证**（law-ai 线：rerank 三跑收口
38492374586→dev1/sha-a5e6c87；websearch 一次过 38516176793→sha-872b5d3；audio
一次过 38519899822→sha-e3a88ea；3.4 一次过 38523922129→sha-6e809d3；前端页
38530888676→sha-7a1f7c7（含 check:i18n+vue-tsc+vite build），均未部署）；缝点实插
累计=路由注册/handler 服务访问器/平台清单/service 账号仓储访问器/车道平台谓词排除/
分组价目 rerank/测试阈值/**前端路由+导航+i18n 词条**（§二表）。
车道 v1 平台定案：audio+rerank=siliconflow、websearch=serpapi。
**品牌面=上游配置驱动**（admin site_name）。**§3/§5.2/§5.3 真回执+面板入账+浏览器
眼见=部署窗项目**（websearch key 现成；rerank+audio 待硅基 key；按 runbook §7
车道窗附加探针照单执行）。车道 v1 形状：rerank=按请求（新价目字段）/websearch=
按次（复用 WebSearchCalls）/audio=stt 小时+tts 百万字符（复用 Group 音频三价）；
统一错误面=400/422→400、其余→502、池空 503、无凭据 502，全部含 lane+engine 标识、
不外泄、不计费。

**侦察期三项关键结论**（决定 §2 实施形状）：1. 上游**无 HTTP `/v1/audio/*` 端点**（Grok 音频是 WS realtime）——audio 车道端点全新，无路由冲突；
2. passthrough 是 codex/responses 专用**非通配 `/v1/*` 兜底**——车道路由不撞透传面；
3. audio+websearch 的价目与计量机器**上游全有**，车道=适配器+路由+接线；真正新增量只剩 rerank 价目字段与三车道上游池。

## 三、月度窗台账（含三月检查点记分）

规则：月度常规 + 安全快车道（notes 见安全字样天级单独滚）。每窗登记：

| 窗 | 上游 tag | 产出 tag | 缝点冲突 | merge 用时 | 探针 | 备注 |
|---|---|---|---|---|---|---|
| 2026-11 常规窗（**2026-11-10 补记，首行**） | `v0.2.19`（2026-10-28 18:03） | `ciyuan-v0.2.19-1`（2026-11-06 01:15）→ 生产 `sha-9211d4a`（`+guard`，2026-11-07 08:53 relay） | 真冲突 3：`api_key_auth_cache_impl.go`（fork v25 `rerank_price_per_request` 与上游 v25 `image_count_billing` 同号碰撞 → 升 **v26**，双来源注释）、`EditAccountModal.vue`（车道钉扎字段 ∧ 按张计费开关，**已登记缝点**）、`antigravity_gateway_service_test.go`（两侧用例并存、语义不弱化）。**其中 2 处在 §二 未登记**：按 runbook §2「缝点外冲突=纪律违规，须停下来补登记」应补而未补（`api_key_auth_cache_impl.go` 的风险形态例外——runbook §3 已把「快照形状变更必升版本号」作坑记，但该文件本身未入 §二 表）；见下行挂账 | **约 1.4h**（`7993f1c99` 2026-11-05 23:52 → `ciyuan-v0.2.19-1` 2026-11-06 01:15，含机械合流 + 三处缝点解冲突 + ent 对账 + tag；由 git 时间戳反推，非人工计时）。另有**窗延迟 8 天**：上游 tag 10-28 → 合流提交 11-05，超「当周内完成」口径 | 部署后四件：健康探针、`upstream-queue-metrics` 200（`queue_depth`/`queue_rejected_total`/`aimd_concurrency`/`aimd_state`）、鉴权缓存 **v26 重建生效**（旧 v25 快照被拒、rerank 价与按张计费字段非 nil）、pod 内 `/app/sub2api` 时间戳 + `strings` 命中守卫文案 | 迁移 **246 同号共存**不重命名（fork `246_group_rerank_price_per_request` 与上游 `246_enable_gemini_image_generation_groups`/`247_scoped_admin_api_keys`/`248_group_image_count_billing`），执行器按文件名序；go.mod **1.27.3**（钉版注释同步改，旧「钉 1.27.0」前提已失效）；GPT-6.1 Terra 上线零后台配置；`image_count_billing` 全组维持关（挂账评估单）；**本窗归档时 §三 未记——归档发生在 sub2api 仓 openspec、台账在 paas，跨仓失联**，本行 2026-11-10 补记；另该 change 的 **5.3 终验项未勾即归档**，且「缝点外冲突」两条未补登记，均挂账

> **测量口径（2026-11-10 定，防再出空表）**：「merge 用时」= 合流合并提交时间 → 产出语义 tag
> 时间，含缝点解冲突 / ent 对账 / 迁移对账 / 打 tag；**不含**事前功能开发（如本窗 AIMD 三刀
> 11-05 12:32 起）与事后补丁出片（如 `+guard`）。取 git 时间戳，不靠人工计时；取不到就如实写
> 「未记」，不估填。
> **回填纪律（同 `ciyuan-integration-charter` D7）**：sub2api 仓任何 change 归档时，必须同批
> 复核本表——本窗漏记就是这么发生的。

**三月检查点**（ADR-0024/spec）：单窗 merge 用时 >1 天 → 触发显式降级决策
（继续/冻结/外提），记入下表：

| 触发日 | 事实 | 决策 | 理由 |
|---|---|---|---|
| —（截至 2026-11-10 无触发） | 唯一已记窗 2026-11 常规窗 merge 用时约 1.4h（<1 天） | 继续（无需决策） | 未达阈值；空表含义＝「未触发」，不是「没人记」 |

**已知挂账（本表回填时发现，未在本文件外单独立单）**：

- 缝点外冲突 2 处未补登记（`api_key_auth_cache_impl.go`、`antigravity_gateway_service_test.go`）——
  下一次月度窗开始前决定是「补进 §二」还是「明确归入 runbook §3 快照坑」，二选一，不留模糊。
- `merge-upstream-v0-2-19` 的 5.3 终验项未勾即归档——归档动作与 tasks 勾账脱节，后续归档前先核 tasks。
- 窗延迟 8 天（上游 10-28 → 合流 11-05）尚未定性：是「当月窗触发晚」还是「合流工作量大」，
  下窗需要用同一口径再测一次才能判分，暂不据此改口径。

## 四、CI / 出片挂账

- **org GHA 账单阻断（持续）**：FDT 私有仓 Actions 不可用（2026-10-14 复验：私有额度
  2011/2000 仍耗尽）。**CI 归宿已定（§1 口径）：law-ai-official/sub2api-images 快照线**
  ——每次代码窗快照推该仓，test job（unit，go 钉 1.27.0）+ image 出片同线；本地先跑
  全量测试再推快照省额度。**额度护栏（10-14 fd-build-channel）**：law-ai 本月余
  ~320 min，月内多窗开发若耗尽 → 备胎 testaction001-005/build-pool 通用池
  （fd-build-snapshot 直接可用）或等 11-01 月初重置；仓转公开（免费无限）留作
  用户级决策不入自动路径。
- **出片线 = law-ai-official/sub2api-images**（快照法，同 platform-images 模式）；
  manifest 引用镜像 tag，注释写明对应真 tag/commit。relay 已登记 finddata/sub2api
  （首见 tag 自动携带，无需手动补单）。
- **Go 版本坑（首跑实证）**：自线 CI 必须钉 **go 1.27.0** 对齐上游 CI（上游三处
  硬断言 1.27.0）；按 go.mod toolchain 解析到 1.27.2 时分配器行为差异会让
  `billing_inflight_reservation_test` 的 8MB 内存上界断言越线（8599272 ≥ 8388608）。
- **版本戳坑（首跑实证）**：Dockerfile 版本优先级 = 构建参数 VERSION > git tag >
  `cmd/server/VERSION` 兜底；快照仓无 git tag，上游兜底文件=0.2.15 致版本端点
  报错版。image.yml 已传 `VERSION=<ciyuan-tag>`，版本端点从此自报语义版（对齐
  registry fork `/api/version=fd-x` 探针惯例）。
- **TCR 同 tag 覆写坑（首跑实证）**：relay seen 账本挡同 tag 重灌（手动补单也
  不覆写 ccr 侧 manifest）→ **部署永远引用 sha tag**（IfNotPresent 同 tag 不
  重拉 + relay 语义 tag 停旧，双重理由）；语义 tag 只作命名锚点。
- **快照旗标语反转坑（10-14 实锤）**：`fd-build-snapshot --keep-workflows` 语义=
  「同步**源仓自带** .github」（供要带 workflows 的仓用），**不是**「保留目标仓
  workflows」——sub2api 快照线误传该旗标会把上游四套 workflow 同步进镜像仓、
  **删掉 image.yml** 并触发上游 CI/CLA/Security/Release 烧额度。**正确用法=
  不传旗标**（默认排除 /.github=保护目标仓 workflows+免 macOS×10 误触）。
  事故修复配方：`gh run cancel` 两个误触 run → clone 镜像仓 `git checkout
  <上一好提交> -- .github/workflows/image.yml` + 删上游 workflows → push
  （image.yml 随修复提交自动重触发）。本次损耗 ~3 分钟额度。
- **ciyuan-tag 文件进 fork 仓**（10-14 起）：下一版语义 tag 声明从镜像仓专属文件
  改为 fork 仓 tracked 文件（rsync --delete 镜像模式下仓库根额外文件会被删）；
  快照自动携带，release 时改此文件+快照即出正确 VERSION。
- TCR：hkccr `finddata/sub2api` 首推自建成功；ccr 侧同库 0.2.7 在用历史。

**升级配方（照单执行）**：快照推 law-ai 仓（先改 `ciyuan-tag`，workflow 自动
双 tag 出片）→ 等 relay ≤5 分钟带 sha tag → fd-infra-deploy 滚 sha tag →
push gitee → `kubectl --context cheap -n argocd exec deploy/argocd-server --
argocd app sync sub2api --server localhost:8080 --plaintext`（in-pod 必带
--server，命令会挂 websocket 但 sync 已执行，直接看 rollout）→ 探针四件套
（/health、admin version=x-api-key 头走 auth-server 容器 env 的
SUB2API_ADMIN_KEY、公网门面、panic 扫零）。admin key 头=**x-api-key** 非 Bearer。

**备用池配方（2026-10-14 起，law-ai 额度尽时）**：
`fd-build-snapshot ~/finddata/sub2api -R testaction001/build-pool --namespace finddata --image sub2api`
——池出片 tag=**快照仓 commit 短 sha（≠源码仓 sha，差一位别搞混）**；workflow 已
补丁支持仓根 ciyuan-tag→语义 tag+VERSION 构建参数；ArgoCD sync 前先
`annotate refresh=normal` 等 revision 变更；relay 手动补单
`ssh cheap3 '/usr/local/bin/tcr-relay-sync.sh finddata/sub2api <tag>'`。

## 五、上游回馈登记（能上游则上游）

> 操作手册与提交计划：`docs/sub2api-fork-patches/upstream-pr-candidates.md`
> （形状草案/实施步骤/CLA/退役流程）；谱系纪律见 spec「上游回馈优先」。

| 候选 | 上游凭据 | 状态 |
|---|---|---|
| 按 key 自助用量查询端点 | issue #6421（ADR-0011 等此）**仍 open**（2026-08-14 立、08-31 更新，无关联 PR；近邻端点 `/v1/sub2api/billing` 已在上游=形状对齐锚点） | **计划就绪**（计划文档§候选①：形状草案/数据源复用/单提交流程；触发时机=车道部署窗后） |
| 虚拟用量端点 | ADR-0014 backlog（門面结算切账本权威的前置） | **计划就绪**（计划文档§候选②：形状草案+幂等要求；前置=候选①先合或先对齐语义） |

CLA：上游有 CLA.md，首次 PR 前签署（覆盖后续 PR）。补丁保持 cherry-pickable 单提交。

## 六、治理手册索引

- **GitOps 双远端陷阱（2026-11-11 实锤，代价一次白等）**：`fd-infra-deploy` 有**两个远端**，
  `origin` = **github**、`gitee` = **gitee**，而 **ArgoCD 跟踪 gitee/main**（runbook §7 写的
  「gitee 为真源」不是修辞）。两者**已真分叉**（实测 211/20）。我把 `afdf9ea` 推到 `origin`
  （github）后，Argo 一直停在旧 rev `015d188`，`refresh=normal` 也没用——因为那个提交在
  gitee 上根本不存在。**判据**：推完必看 `git ls-remote --heads gitee main` 与 Argo 的
  `status.sync.revision` 是否一致；不一致先查远端，别去重启 repo-server（那次不是凭据问题）。
  **纪律**：改 GitOps 清单一律 `git push gitee HEAD:main`，并确认 `gitee/main` 内容含新 tag。


- **按线指标与花费异常（2026-11-11，`sub2api` 仓 `tools/line-metrics.sql`）**：一个文件、一份别名表、
  四节输出（花费 / 错误按状态码 / 延迟 avg+p95 / 花费异常）。用法同归因：
  ```bash
  kubectl --context cheap-ts -n sub2api exec -i sub2api-postgres-0 -- \
    psql -U sub2api -d sub2api -v days=30 -f - < tools/line-metrics.sql
  ```
  **异常节用双信号**（周环比 ≥2× 或 近 3 日均量 ≥2× 前 7 日均量），因为单信号各有盲区：
  `wanxing-probe-1791014842023` 日内从 76 涨到 2,293（30×），但周环比仅 1.7×——
  **「30 倍」是日内数字，不是月趋势**（此处曾被我误读，已在 charter design 订正）。
  当前命中：`特价`（2.0× / 斜坡 3.4×，$115.47/周）、`wanxing-probe-1791014842023`
  （斜坡 3.3×，$12.57，全打 deepseek-v4.1-flash，avg 17.6s）。
  **结构性事实**：87% 花费挂 `admin@finddatatech.cloud`（user 1，余额≈$1 亿，`total_recharged=0`），
  `特价`/`openrouter` 两把千级日请求的 key 都属它——**词元当前消耗几乎全在平台内部**，
  按线归因得到的是「内部用途」分类而非收入结构。做商业报表前必须先分清这两件事。

- **`特价` / `openrouter` 的用途与免费档经济账（2026-11-11，用途经用户确认）**：这两把 key 跑
  **embedding 相关工作负载**，并用上游 `:free` **日内免费档**替代 deepseek。替代率差 23 倍：
  `特价` **23.1%**（13,072/56,533）、`openrouter` **1.0%**（743/71,082）。
  若 `openrouter` 提到前者水平 ≈ 省 **$58/月**（按 $309.41/69,518 ≈ $0.00445/次折算，年化 ~$700）。
  **但上限不在策略，在免费档自己**：7 天免费档失败 6,890 次（503 占 4,800、502 占 1,257、429 占 833），
  是 deepseek 侧 3,514 次的两倍；每次免费档 503 都回落 deepseek 付费 ≈ **$130/月被逼出来的开销**。
  故优化点是「免费档 503 风暴时快速熔断、短时直连」，不是「叫他们多用免费档」。
  另：`deepseek` 侧 328 次 **400**（请求形状错误）说明替代切换时参数不兼容——实现正确性问题，
  比容量问题更值得先修。免费档延迟也不是免费的：`dots-studio/dots-3-note-preview:free` 平均 24,610ms。
  **勘误**：我曾试图用 `user_agent`/`client_ip` 反推这两把 key 的用途——方向错了，用途用户直接给过；
  查 IP 的那一步属无效劳动，记此以免重复。

- **失败面在哪查（2026-11-10 定位）**：履约失败**不在** `usage_logs`（那里只有成功计费行），
  在 **`ops_error_logs`**——含 `api_key_id`/`model`/`status_code`/`error_phase`/`error_type`/
  `error_owner`/`is_business_limited`/`upstream_status_code`/`retry_after_seconds`，按线×模型×状态切所需字段齐备。
  只读示例（按线看 403/503/429 分布）：
  ```bash
  kubectl --context cheap-ts -n sub2api exec sub2api-postgres-0 -- psql -U sub2api -d sub2api -c "
  SELECT split_part(k.name,'-',1) seg, e.status_code, count(*)
  FROM ops_error_logs e JOIN api_keys k ON k.id=e.api_key_id
  WHERE e.created_at >= now() - interval '7 days'
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;"
  ```
  **实测 7 天 30,724 条：403 50.1% / 503 31.8% / 502 8.4% / 429 仅 6.6%**——主要故障是权限被拒，
  不是限流。其中 **15,392 条（50%）来自单把 key `wx-wizard-verify`**（`api_keys` id=53、
  group_id=3 `core`、2026-10-12 建），消息 `No active subscription found for this group`；
  14 天每日 699～3,722 次、**至今仍在打**。后果：不分线的错误率看板看到的是这把 key 的心跳。
  **处置（禁用/改分组/排除出看板）属运营决定，未擅自处理。**

- **默认模型自查（2026-11-10，四条线各一）**：词元能力快照现在能回答「我配置的默认模型此刻可服务吗」。
  每仓一行，只读、无行为变更、任何失败 `checked=false`：
  ```bash
  # 时论 fd-shilun（worktree 分支 feat/ciyuan-model-check，df378ff）
  FD_SHILUN_LLM_API_KEY=<key> FD_SHILUN_LLM_BASE_URL=https://token.finddatatech.cloud/v1 \
    python -m fd_shilun_api.llm --check-model
  # 之思 fd-zhesi（2cae304）
  FD_ZHESI_LLM_API_KEY=<key> FD_ZHESI_LLM_BASE_URL=https://token.finddatatech.cloud/v1 \
    python -m fd_zhesi_api.llm --check-model
  # 正信 fd-zhengxin（732d490；env 前缀 FDZX__，该仓无 remote，已并入本地 main）
  FDZX__LLM_API_KEY=<key> FDZX__LLM_BASE_URL=https://token.finddatatech.cloud/v1 \
    python -m fd_zhengxin_api.llm --check-model
  # 柏讯 fd-wire（0e67991；走 AiSettings 的 TOKEN_GATEWAY_*）
  TOKEN_GATEWAY_KEY=<key> TOKEN_GATEWAY_URL=https://token.finddatatech.cloud \
    python -m fd_wire_api.ai.llm --check-model
  ```
  输出三态：在 `serving` → 可服务；只在 `permitted_only` → 白名单放行但无账号（调用会失败）；
  两处都没有 → 这把 key 看不到它（多半 id 漂移）。
  **纪律：必须用本仓自己的 key 跑**——快照是 key-scoped 的，实测同一天用别项目的 key 得出
  「`glm-4.7` 不可服务」是假阳性，换 `wire-ai-build-prod-20261010` 后它在 serving（101 个）。
  **实测基线（30/90 天，2026-11-10）**：`deepseek-v4.1-flash` 190,332 次/34 key 是工作马；
  各仓硬编码的 `gpt-5.4-mini` 90 天仅 4 次、`glm-4.7` **90 天 0 次**——多数默认值是死配置。
  另：`%shilun%`/`%zhesi%`/`%zhengxin%` 在 `api_keys` 里各 0 把，这三条线目前并不经词元调用，
  故它们上面的自查**暂时是理论性的**（识律/柏讯真在调）。

- **按线归因口径（2026-11-10，`sub2api` 仓 `tools/attribution-by-line.sql`）**：能力快照回答
  「能不能服务」，不回答「每条线花了多少」。该 SQL（只读）把口径钉成一个版本化文件：
  别名映射写在 `aliases(seg, line, why)` 的 VALUES 里（`lexkg→识律`、`wx→萬星`、
  `law/lawbench→law-bench`、`yizuo/platform→壹座`），新增线改这个文件并在 `why` 写清
  「为什么是同一实体」，**不许散在临时 SQL 里**。三条硬纪律写在文件头：无法归因的键单列
  （不并入任何线）、别名只归一并写法（不确定留 unknown）、`actual_cost` 与 `total_cost` 都给。
  **实测 30 天（2026-10-11 起）：253,348 请求 / $688.21**——openrouter 45.0%（外部/中转，
  **不是产品线**）、`特价` 26.9%（促销键，**不是产品线**）、萬星 16.7%、识律 9.1%、
  其余各线合计不到 3%。**维度声明**：本表是「计费主体」（谁持 key 调用），不是「受益方」——
  `wanxing-lex-console-copilot` 这类键首段是萬星、实际替识律调，按首段归因会把识律的花费
  记到萬星头上。要做受益方口径需要另一张键→受益方映射，目前没有，也不靠猜。
  用法：`kubectl --context cheap-ts -n sub2api exec -i sub2api-postgres-0 -- psql -U sub2api -d sub2api -v days=30 -f - < tools/attribution-by-line.sql`

- **钥匙收口（2026-10-15，paas 侧 change `search-relay-via-ciyuan`）**：SerpAPI
  key 从「relay 自持 + 车道池双份」收口为**只存车道账号池**。词元侧零代码动作=
  admin 建 internal 分组（id=10 `internal-search-relay`，platform=serpapi、
  is_exclusive、**web_search_price_per_call=0**）+ admin 用户 allowed_groups 补
  10 + 建专用 key #68 `search-relay-internal`；探针 `POST /v1/search` 200 且
  用量行 93779 `serpapi:google_light` **total_cost=0**（归因 acct 37，计量保留）。
  paas 侧 relay 改造（`services/search-relay/index.js`）：keys.json 新增
  `ciyuan:{url,key}`（env `CIYUAN_URL/CIYUAN_KEY` 兜底）、车道优先+冷备直连
  （3 连败 60s 熔断、探活恢复、keys.json 重载即清熔断）、`/v1/stats` 增
  `upstream{mode,reachable,breakerOpen,laneCalls,laneFailures,fallbacks}`、
  日志 `route=lane|direct-fallback|direct`；**对外契约（请求/响应形状、鉴权、
  x-search-source 三态）零变化**。单测 `scripts/test-search-relay-lane.mjs` 5/5
  + 既有 byok 11/11、scoped 9/9 不回归。冷备窗口观察一周后退役直连路径。
  **面板行待 platform 出片**（2.1 代码在 paas main 946b8e6，字段缺失时优雅隐藏，
  功能与回滚不受影响）。
- **直连退役（2026-10-22，paas 侧 change `retire-search-relay-direct`）**：观察窗
  10-15→10-22 到期双门全过（pod 6.69 天 0 重启 `reachable=true/breakerOpen=false`
  常绿；`fallbacks=4/laneFailures=3` 全系 10-15 07:35 验收演练、此后零回退）→ 删
  直连路径与 `serpapi[]` 冷备（paas `589930aa`：`serpapiSearch/poolSearch/
  directSearchWithOverride` + 两级冷却 + `keyFailures/poolDry/fallbacks` 全删；
  无车道拒启；breaker 降级为纯可达性信号；车道故障→503 `search upstream
  unavailable (websearch lane): …`）。面板去 per-key 冷却视图/poolDry 行、上游行
  改显 laneFailures；ops-console lane 视图。**生产**：fd-infra-deploy `96819e3`
  ConfigMap 重嵌（pod 内 md5 一致）+ secret `search-relay-keys` 去 `serpapi/glm`
  （tokens/scoped_master 原样，退役 key 本地留底不入仓）+ rollout restart；platform
  `sha-384a979`（digest a7e380a6，三清单 `0188252`）。验收四件：启动行
  `upstream=ciyuan-lane, 1 static token(s)…` **无 standby**；真搜 200 `route=lane`；
  BYOK 三态 user/pool/pool-after-user-failure 全由车道裁决；坏车道 key 演练 503
  明确命名车道、恢复后回 200。单测 lane 6 + byok 11 + scoped 10。**回滚**=revert
  589930aa + 重嵌 + secret 回填 serpapi。词元侧**零动作**（internal 分组/key #68
  不变）。
- **Origin change（已归档）**：`openspec/changes/archive/2026-10-15-fork-sub2api-ciyuan`
  （proposal/design/tasks 20 项全绿）；**对应主 spec**：`openspec/specs/ciyuan-fork-lineage`
  （谱系治理 6 需求）+ `openspec/specs/ciyuan-gateway-lanes`（三车道契约与计量 6 需求）。
  后续车道增量 change 直接 delta 这两个 capability，勿新建同名。
- **月度合并窗 runbook**：`docs/sub2api-fork-patches/merge-window-runbook.md`
  （十节照单执行：窗型触发/notes 预判/merge 纪律/缝点解冲突+ent 迁移/本地轻测+
  CI 重测+金样七面/安全快车道判据/出片/部署探针/台账登记/三月检查点/上游回馈）
- **上游 PR 候选计划**：`docs/sub2api-fork-patches/upstream-pr-candidates.md`
- **三月检查点**：§三检查点表（单窗 merge 用时 >1 天触发继续/冻结/外提三选一）
