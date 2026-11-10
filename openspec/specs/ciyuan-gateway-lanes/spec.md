# 词元车道：audio / rerank / websearch 的对外契约与计量

## Purpose

萬星·词元（sub2api 增量谱系 fork）在 chat 订阅池之外对外提供三类非 chat 模型能力——
语音（ASR+TTS）、rerank、serpapi 式搜索中转——规定其对外协议形状、鉴权口径、
计量单位与账本归属，使外部调用者凭词元 key 按量消费、平台凭既有账本机器收费。

> 实现归属：sub2api fork 仓——本 spec 为跨仓行为契约，审计时按文件间一致性核对。

## Requirements

### Requirement: 车道统一凭据与既有鉴权链

词元三车道与 chat 入口共用同一 API key 体系与鉴权链；调用者不因换车道而换身份。

#### Scenario: 车道请求持既有 key 通过鉴权
- **WHEN** 调用者以任一有效词元 API key 请求三车道任一端点
- **THEN** 鉴权结果与其请求 chat 入口完全一致（同 key 同身份同余额账本）

#### Scenario: 无效 key 拒绝口径一致
- **WHEN** 调用者以无效/吊销 key 请求车道端点
- **THEN** 拒绝状态码与错误体形状与 chat 入口对无效 key 的应答一致

### Requirement: 语音车道（ASR+TTS）按事实标准协议暴露

语音车道对外说 OpenAI 音频事实标准形状；上游供应商可插拔，调用者无感知。

#### Scenario: ASR 转写
- **WHEN** 调用者 `POST /v1/audio/transcriptions` 上传音频文件并指定模型
- **THEN** 返回 OpenAI 转写形状的应答（含转写文本），并按音频时长计量计费

#### Scenario: TTS 合成
- **WHEN** 调者 `POST /v1/audio/speech` 提交文本、voice 与格式参数
- **THEN** 返回对应格式的音频流，并按合成字符数计量计费

#### Scenario: 换上游供应商调用者零改造
- **WHEN** 同一模型名背后的上游供应商变更
- **THEN** 对外协议形状与响应语义不变，仅延迟/音色等非契约属性可能变化

### Requirement: 语音车道支持跨协议上游并保持对外契约不变

词元语音车道（`POST /v1/audio/transcriptions`、`POST /v1/audio/speech`）SHALL
支持**跨协议**的上游供应商：除既有 OpenAI 兼容 HTTP 外，SHALL 可接入豆包语音
（openspeech V3）与腾讯云语音（云 API 3.0）。上游协议的选择依据 SHALL 落在
**账号级标注**上，不得依赖全局配置，使同一车道可混布多协议上游。

无论实际命中哪个上游协议，对调用者的请求形状与响应形状 SHALL 保持一致
（OpenAI 音频事实标准）；调用者 SHALL NOT 因上游换协议而改造。

#### Scenario: 同车道混布多协议上游仍按优先级轮转

- **WHEN** 车道内同时存在 OpenAI 兼容、豆包、腾讯云三类账号，且高优先级账号上游失败
- **THEN** 请求由下一候选（可能是另一协议族的账号）完成，调用者收到正常应答，
  响应形状与首选账号成功时一致

#### Scenario: 未标注协议的历史账号行为不变

- **WHEN** 账号凭据未标注上游协议
- **THEN** 该账号按 OpenAI 兼容协议处理，既有行为与变更前逐字节一致

#### Scenario: 上游协议标识如实标注在用量面

- **WHEN** 任一请求命中某个上游账号并成功计费
- **THEN** 该笔用量行的上游标识等于**实际命中的账号**所属协议（形如
  `doubao:<音色>`、`tencent:<音色编号>`），不得硬编码为单一供应商

#### Scenario: 错误体 engine 为车道级标识（已知边界）

- **WHEN** 请求在上游账号失败并最终以车道级错误体应答
- **THEN** 错误体含 lane 与 engine 字段，其中 engine 为**车道级**上游标识
  （audio 车道现为 `openainext`），而非失败账号所属协议；按实际命中账号标注
  错误体 engine 是已登记的后续项，在此之前调用方 MUST NOT 把错误体 engine
  解读为失败账号的协议

### Requirement: 豆包语音上游的 TTS 合成

词元 SHALL 能通过豆包语音（openspeech）的 WebSocket 双向流式接口完成 TTS：
按官方 V3 二进制帧协议建连、启动会话、下发文本、收齐音频帧并组装为可播放音频。

帧编解码 SHALL 遵守官方定义：协议版本与 header size 位于首字节的高低半字节；
事件帧 SHALL 携带 int32 事件编号；session 类事件 SHALL 携带会话标识长度与标识；
音频响应帧 SHALL 按裸二进制处理（SHALL NOT 当作 base64 文本解码）。

#### Scenario: 合成返回可播放音频

- **WHEN** 调用者以 OpenAI `speech` 形状提交文本与音色，请求命中豆包账号
- **THEN** 返回的音频能被标准播放器识别为合法音频容器（MPEG/ID3 可判读），
  且合成字符数计入该 key 的用量与扣费

#### Scenario: 音色与资源不匹配时如实失败

- **WHEN** 请求的音色与该账号资源版本不匹配（如 1.0 音色配 2.0 资源）
- **THEN** 该笔请求失败并如实报错，账号按既有失败分级冷却，不产生计费

### Requirement: 豆包语音上游的 ASR 转写（异步任务）

词元 SHALL 能通过豆包语音的录音文件识别接口完成 ASR：提交任务、按任务号轮询、
取回转写文本。该链路 SHALL 在请求生命周期内完成提交与有限轮询；轮询超出上限
时 SHALL 如实返回失败（SHALL NOT 静默返回空文本或假成功）。

#### Scenario: 转写返回文本并按时长计费

- **WHEN** 调用者提交一段音频、请求命中豆包账号
- **THEN** 返回 OpenAI 转写形状的文本，并按上游返回的音频时长计量计费

#### Scenario: 轮询超时如实失败且不计费

- **WHEN** 识别任务在适配器轮询上限内未完成
- **THEN** 返回车道级错误（含 lane 与 engine 标识），不产生计费，
  错误的文本中不出现上游内部细节

#### Scenario: 上游要求公网可达音频来源的约束被显式承载

- **WHEN** 上游协议只接受音频 URL 而非请求体字节
- **THEN** 适配器 SHALL 自行完成音频的可达化并记录该约束，SHALL NOT 把该
  上游差异泄露为对调用者的协议变更；可达化前缀来源为账号凭据
  `audio_public_base_url` 优先、环境变量 `LANE_AUDIO_PUBLIC_BASE_URL` 兜底

#### Scenario: 可达化前缀未配置时明确失败换号而非静默降级

- **WHEN** 请求命中豆包账号做 ASR，而账号凭据与环境变量均未提供可达化前缀
- **THEN** 该账号本次按瞬态失败处理（短冷却、换下一候选），SHALL NOT 记为
  「账号缺凭据」落长冷却；告警指明缺失的是部署侧前缀；池内其他协议账号可用时
  请求由其完成

### Requirement: 腾讯云语音上游的接入

词元 SHALL 能通过腾讯云云 API 3.0 接入 TTS（`TextToVoice`）与 ASR（一句话识别）。
请求签名 SHALL 符合 TC3-HMAC-SHA256；凭据（SecretId/SecretKey，可选 Token）
SHALL 仅存于账号凭据并在日志与错误体中脱敏。

#### Scenario: TTS 合成返回音频并按字符计费

- **WHEN** 请求命中腾讯云账号
- **THEN** 返回可播放音频（上游 Base64 音频体须解码后下发），
  并按合成字符数计量计费

#### Scenario: ASR 一句话识别返回文本并按时长计费

- **WHEN** 调用者提交不超过上游限制时长的音频，请求命中腾讯云账号
- **THEN** 返回 OpenAI 转写形状的文本，并按音频时长计量计费

#### Scenario: 凭据无效时如实失败且不外泄

- **WHEN** 账号凭据无效或签名不被上游接受
- **THEN** 请求返回车道级错误、账号按额度/鉴权类长冷却处理，
  错误体与日志中不出现 SecretId/SecretKey 明文

#### Scenario: 采样率未指定时取本协议默认且不跨协议串用

- **WHEN** 调用者未指定采样率，请求命中腾讯云账号
- **THEN** 适配器取腾讯云自身的默认采样率（SHALL NOT 把另一协议的默认值原样
  传给上游）；若所选音色不支持请求的采样率，SHALL 以默认采样率重试一次后再判失败

### Requirement: 语音上游多协议下的失败分级与冷却一致

跨协议接入后，上游失败的分级判据 SHALL 与既有口径一致：额度耗尽/鉴权失效类
落长冷却，网络/超时/5xx 类落短冷却；冷却中的账号 SHALL 退出候选。
各协议适配器 SHALL 把上游状态如实映射到既有分级判据，SHALL NOT 引入与该
判据冲突的第二套规则。

#### Scenario: 某协议族账号全数冷却后按车道级错误处理

- **WHEN** 某协议族的全部账号处于冷却，且池内无其他可用候选
- **THEN** 调用者收到车道级 5xx 统一错误体（含 lane 与 engine），不计费

#### Scenario: 单一协议的瞬态失败不拖垮其他协议候选

- **WHEN** 某协议的账号因瞬态失败进入短冷却，池内另一协议账号可用
- **THEN** 后续请求由另一协议账号正常服务，不受该冷却影响

#### Scenario: 以 HTTP 200 承载的上游业务错误按业务码分级

- **WHEN** 上游以 HTTP 200 加响应体内业务错误码返回失败（云 API 3.0 惯例）
- **THEN** 适配器 SHALL 先按业务码归类为鉴权/额度/参数/上游故障，再走既有分级
  冷却；SHALL NOT 把 200 当成功，也 SHALL NOT 把「status 200」写成冷却原因；
  业务码与消息进告警日志以便判别

### Requirement: rerank 车道按事实标准协议暴露

rerank 车道对外说 Cohere/Jina 式 `/v1/rerank` 形状；输入 query+documents，输出排序结果。

#### Scenario: 重排请求
- **WHEN** 调用者 `POST /v1/rerank` 提交 query、documents 与 top_n
- **THEN** 返回按相关度排序的文档索引序列（index/score/relevance 形状），按请求计量计费

### Requirement: 搜索车道的自有统一协议

搜索中转对外只暴露一套自有协议：engine 选择器 + 统一响应信封；上游差异吞在适配器内。

#### Scenario: 统一入口搜索
- **WHEN** 调用者 `POST /v1/search` 提交 `{engine, q, num, ...}` 且 engine 为已接入供应商
- **THEN** 返回统一信封：`meta`（engine、latency）、`results[]`（归一化条目：title/url/snippet/position）、`usage`（本请求计量），并按次计费

#### Scenario: 切换 engine 调用者零改造
- **WHEN** 同一 query 仅更换 engine 字段
- **THEN** 响应仍为同一统一信封形状，条目字段语义不变

#### Scenario: 未知 engine 拒绝
- **WHEN** engine 不在已接入集合内
- **THEN** 返回明确错误（含可用 engine 列表），不产生计费

### Requirement: 车道用量写回原生账本

三车道用量与费用进入词元既有账本体系：key 消费窗口、分组倍率、余额、用量面板
对车道用量原生生效；车道价目独立于 chat 模型价目配置。

#### Scenario: 车道消费入账
- **WHEN** 任一车道请求成功计费
- **THEN** 该笔用量出现在请求 key 的用量记录与余额扣减中，形状与 chat 用量可区分（车道/单位标注）

#### Scenario: 消费窗口与余额硬顶对车道生效
- **WHEN** key 的消费窗口或余额已耗尽时发起车道请求
- **THEN** 请求被拒（口径同 chat 入口），上游供应商不被触达

### Requirement: 上游故障不外泄且如实标注

车道上游不可达/超时/返回异常时，调用者收到统一错误形状，不透出上游凭据或内部细节；
上游供应商身份在用量记录中如实标注。

#### Scenario: 上游不可达
- **WHEN** 车道上游全部不可用
- **THEN** 调用者收到 5xx 统一错误体（含 engine/lane 标识），无上游 URL/key 泄露，不计费

### Requirement: 车道上游池多账号轮转与失败分级冷却

三车道的上游账号池 SHALL 支持多账号轮转：按调度优先级稳定序遍历候选，
单账号上游失败时自动换下一个候选重试，全池候选耗尽才返回车道级 5xx。
账号失败 SHALL 按性质分级冷却并落持久层（跨重启有效、管理面可见）：
额度耗尽/鉴权失效类冷却长时窗，瞬态类（网络/超时）冷却短时窗；冷却期内的
账号不再进入候选。冷却时长与分级判据 SHALL 与平台既有 search-relay 口径
对齐（额度/auth 类 12 小时，瞬态类 60 秒）。

#### Scenario: 单账号额度耗尽自动换池内下一账号

- **WHEN** 某车道优先账号上游返回额度耗尽/鉴权失效类失败，且池内存在次优先账号
- **THEN** 该请求由次优先账号完成，调用者收到正常应答；优先账号进入长时窗冷却，管理面可见其冷却状态与原因

#### Scenario: 瞬态失败短冷却后恢复参与调度

- **WHEN** 某账号上游出现网络/超时类瞬态失败
- **THEN** 该账号进入短时窗冷却，期间请求由其他候选账号服务；冷却期满后该账号自动回到候选序列

#### Scenario: 全池耗尽如实 5xx

- **WHEN** 车道上游池内所有账号均处于冷却或不可调度状态
- **THEN** 调用者收到车道级 5xx 统一错误体（含 lane 标识），不外泄上游细节，不计费

### Requirement: websearch 车道请求级用户 key 覆盖（BYOK）

websearch 车道 SHALL 支持调用者在请求头携带自己的搜索供应商 key（BYOK）：
BYOK 请求优先用该 key 直连上游，成功则按用户来源应答；失败时 SHALL 回退
平台池完成请求，且响应头如实标注实际来源三态（用户 key / 池 / 用户 key
失败后回退池）。BYOK 笔 SHALL 计量入账但费率为零（用量行保留归因，不产生
平台计费）；BYOK key 不落持久层、不出现在日志与错误文本中。

#### Scenario: 用户 key 优先服务

- **WHEN** 调用者请求携带有效 BYOK key 且该 key 上游调用成功
- **THEN** 应答由用户 key 服务，响应标注来源为用户；该笔用量入账、费率为零

#### Scenario: 用户 key 失败回退池并如实标注

- **WHEN** 调用者携带的 BYOK key 上游调用失败，平台池可用
- **THEN** 请求由平台池完成并正常计费，响应标注来源为「用户 key 失败后回退池」，不向调用者暴露用户 key 的失败细节

#### Scenario: BYOK key 不外泄

- **WHEN** BYOK 请求发生任何失败
- **THEN** 错误体与日志中不出现该 key 的值，仅以不可逆短标识归因

### Requirement: 车道入口页可渲染且文案可编译

面板车道入口页（`/lanes`）SHALL 在任意受支持语言下完整渲染：页面全部文案
（含协议示例形状）SHALL 通过消息编译器校验，含字面量花括号的文案 SHALL 按
vue-i18n 转义约定书写。消息编译类缺陷 SHALL 被 CI 关键测试清单拦截，不得
流入出片。

#### Scenario: 车道页渲染完整

- **WHEN** 已登录用户打开面板「模型车道」页（zh 或 en 界面）
- **THEN** 页面渲染出全部车道卡片（rerank/websearch/ASR/TTS 四行），无白屏、无未捕获异常

#### Scenario: 消息编译门拦截缺陷类

- **WHEN** locale 文案引入未转义花括号等消息编译错误
- **THEN** 关键测试清单（`make test-frontend-critical`，含全量消息预编译守测）失败，合入被拒

### Requirement: 词元的非 chat 模型能力含嵌入且与 chat 入口同源

萬星·词元的非 chat 模型能力 SHALL 含嵌入（embedding）。嵌入经 OpenAI 兼容
`/v1/embeddings` 入口暴露，与 chat 入口同源（经 chat 网关族的鉴权、调度与账本
链路），而非 rerank/audio/websearch 三车道的 LaneAdapter 链路；其专属契约
（模型与维度、上游池、价目、上游钉扎）由 capability `ciyuan-embedding-lane`
规定，本 capability 不重复规定。

#### Scenario: 嵌入入口与 chat 同源

- **WHEN** 调用方请求 `POST /v1/embeddings`
- **THEN** 该请求经 chat 网关族的鉴权、调度与账本链路处理，而非三车道的
  LaneAdapter 链路

#### Scenario: 嵌入用量入既有账本

- **WHEN** 嵌入请求成功计费
- **THEN** 用量进入与 chat 同一账本体系（key 消费窗口、余额、用量面板），
  计费单位按 token（而非三车道的按次/按时长/按字符）

#### Scenario: 三车道既有契约不受嵌入影响

- **WHEN** 嵌入能力上线
- **THEN** rerank / audio / websearch 三车道的协议形状、计量单位与账本归属
  保持不变，本 capability 的既有需求与 Scenario 不需重新验收
