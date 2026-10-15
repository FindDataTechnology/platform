# 词元车道：audio / rerank / websearch 的对外契约与计量

## Purpose

萬星·词元（sub2api 增量谱系 fork）在 chat 订阅池之外对外提供三类非 chat 模型能力——
语音（ASR+TTS）、rerank、serpapi 式搜索中转——规定其对外协议形状、鉴权口径、
计量单位与账本归属，使外部调用者凭词元 key 按量消费、平台凭既有账本机器收费。

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
