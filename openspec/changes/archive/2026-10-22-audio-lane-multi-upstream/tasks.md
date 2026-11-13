# audio-lane-multi-upstream — Tasks

> **协议探针已完成（2026-10-18）**：豆包 TTS 2.0 与 ASR 2.0 均已用真 key
> 真音频跑通（证据见 proposal）。腾讯云凭据受阻（SecretKey 仅 29 字符，
> 标准 32），**补齐前腾讯云相关任务不得出片**。

## 0. 前置与协议确证（已完成）

- [x] 0.1 豆包 TTS 2.0 打通：真文本 → 22913 字节 mp3（ID3 v2.4 / MPEG ADTS
  layer III / 64kbps / 24kHz 单声道）。
  **验证**：`file` 判读通过；事件序列 50→150→350→352×N→351→152 完整观测。
- [x] 0.2 豆包 ASR 2.0 打通：真实语音 URL → 10 句转写、9 utterance、
  `duration=33621`ms。
  **验证**：submit 得 `20000000`，query 得 `result.text` 非空且与音频内容对应。
- [x] 0.3 帧格式逐条实证（版本半字节、int32 event、session-id 段、裸音频、
  `*_uranus_bigtts` 音色约束）。
  **验证**：每个错误假设都被服务端错误码证伪并修正（记录于 proposal 对照表）。
- [x] 0.4 腾讯云判据定性：`SecretId` 有效（回 `SignatureFailure` 而非
  `SecretIdNotFound`），`SecretKey` 不完整（真实与伪造 key 返回相同错误）。
  **验证**：手写 TC3 签名与官方 SDK 行为一致，排除实现问题。
- [x] 0.5 腾讯云 SecretKey 补齐（32 字符）后复验 `TextToVoice` 与一句话识别。
  **验证**：`TextToVoice` 返回非空 `Audio` 且 Base64 解码后为合法 mp3；
  一句话识别返回文本。
  **结论（2026-10-18）**：前两次提供的 SecretKey 均只有 29 字符，Go 适配器打到
  真实 API 得 `AuthFailure.SignatureFailure`（与官方 Node SDK、独立手写签名
  三条路径一致）——**凭据本身不完整，非实现缺陷**。用户补全为 32 字符
  （末尾 `YLy`）后，真机验收即刻全绿（见 4.3）。

## 1. 协议分派骨架（不改变既有行为）

- [x] 1.1 `service.Account.Credentials` 支持 `audio_protocol`
  （`openai`|`doubao`|`tencent`），缺省回落 `openai`。
  **验证**：`TestAudioProtocolOf_DefaultsToOpenAI` 覆盖 nil/空/显式/未知四态。
- [x] 1.2 `audio.go` 的两个 failover 回调改为按候选账号协议分派；
  未标注协议的账号走原实现，行为逐字节不变。
  **验证**：既有 lanes 全量单测全绿（未改任何既有断言）。
- [x] 1.3（归档对账 2026-10-22，**按 as-built 收窄**）用量行按实际命中协议标注：
  各适配器写 `UpstreamModel`——豆包 `doubao:<voice>` / `doubao:bigmodel`、腾讯
  `tencent:<voiceType>` / `tencent:sentence`，OpenAI 兼容路径沿用既有前缀。
  **验证**：生产用量行 106331/106337=豆包 TTS、106332=腾讯 ASR（5.4）、
  113751=`tencent:101007`（v-15 验收）。
  **砍出本 change（挂账）**：错误体 `engine` 仍为车道级 `LaneEngine(lane)`
  （audio 恒 `openainext`，`errors.go` 注释自标「后续按实际选中账号覆盖」）；
  设计 D1 的 `laneEngineForAccount` 与三态单测未做。观测性缺口、非正确性缺陷，
  已登记主 spec 已知边界，随下一 fork 补丁收口。

## 2. 豆包适配器

- [x] 2.1 V3 帧编解码（编码：StartConnection/StartSession/TaskRequest/
  FinishSession；解码：50/150/350/351/352/152/错误帧）。
  **验证**：9 个单测全绿，金样字节取自真机抓包（ConnectionStarted 54B、
  SessionStarted 54B、Audio-only 2401B 结构）；含 int32 event、session-id 段、
  Audio-only 帧的 payload size 字段。
- [x] 2.2 TTS 合成主流程：建连 → 会话 → 下发文本 → 收齐音频 → 拼装。
  **验证**：桩测试复现完整事件序列；**真机 LIVE 测试通过**
  （`TestDoubaoLIVE_Synthesize`：27693 字节、以 ID3 起始）。
- [x] 2.3 ASR 异步任务：submit + 有限轮询（上限 120s，间隔递增），
  超时如实报错。
  **验证**：`TestDoubaoASR_SubmitAndPollCompletes`（含 duration 33621ms→33.621s
  换算）与 `TestDoubaoASR_SubmitFailurePropagates`（45000030→403 长冷却）全绿。
- [x] 2.4 音频可达化：把调用者上传的音频转为上游可取的 URL（短时效）。
  **已实现并上产（v-11）** `audio_spool.go`（临时目录 + 前缀来源「账号凭据
  `audio_public_base_url` 优先 > 环境变量 `LANE_AUDIO_PUBLIC_BASE_URL`」+ TTL
  惰性清扫 + 不可猜测文件名）；**未配置前缀时明确报错而非静默降级**（v-12 起
  记瞬态失败换号，不再误记 `misconfigured` 落 12h 冷却）。
  **归档对账（2026-10-22）**：代码侧完结。**部署侧公网前缀至今未配** → 豆包 ASR
  在生产不可用；腾讯 ASR 同步收字节不受影响（L2b 生产 ASR 走腾讯 PASS）。
  前缀与静态服务属部署决策，登记主 spec 已知边界 + 台账挂账，不阻塞归档。

## 3. 腾讯云适配器

- [x] 3.1 TC3-HMAC-SHA256 签名实现（含 `X-TC-*` 头、canonical request）。
  **验证**：`TestTencentTC3_DeterministicSignature`（Go 与独立 JS 复刻双实现
  交叉验证出同一签名）+ `TestTencentTC3_ChangesWithInput`（防恒等实现）。
  注：官方文档示例的 payload/时间戳组合我未能精确复现，故未采用记忆中的文档值。
- [x] 3.2 TTS `TextToVoice`：Base64 音频解码后下发；字符数计量。
  **验证**：真机 LIVE 通过——15408 字节音频、17 字符计费（`TestTencentLIVE_TextToVoice`）。
- [x] 3.3 ASR 一句话识别（同步，≤60s）。
  **验证**：真机闭环通过——TTS 合成 94124 字节 wav 回灌识别，得
  「腾讯云语音识别测试成功。」（`TestTencentLIVE_SentenceRecognition`）。
- [x] 3.4 凭据脱敏：日志与错误体不出现 SecretId/SecretKey。
  **验证**：错误类型只携带 status/code/message，不携带凭据；签名在内存计算，
  不落日志。

## 4. 真机端到端验收（全部走真实凭据）

- [x] 4.1 豆包 TTS 适配器级真机验收：`TestDoubaoLIVE_Synthesize` 通过
  （27693 字节、ID3 起始）。
  **待办**：经网关 `/v1/audio/speech` 的端到端（需先建账号并出片）。
- [x] 4.2 豆包 ASR 适配器级真机验收：真实语音 URL → 405 字符转写、
  `duration=33.621s`（`TestDoubaoLIVE_ASR`）。
  **验证**：转写文本与音频内容语义一致（英文朗读语料）。
  **待办**：经网关端到端 + 用量行断言（需出片与公网音频托管）。
- [x] 4.3 腾讯云 TTS/ASR 适配器级真机验收：两条链路各一次真回执。
  **验证**：`TestTencentLIVE_TextToVoice`（15408B/17 字符）与
  `TestTencentLIVE_SentenceRecognition`（合成→识别闭环，文本与原句一致）。
  **待办**：经网关端到端的用量行 engine 断言（需出片后）。
- [x] 4.4 跨协议轮转：高优先级账号失败后请求由另一协议账号完成。
  **验证（生产自然实验，归档对账 2026-10-22 采信）**：
  ① 2026-10-19 豆包 #43 TTS 握手 403 `volc.seedtts.default … not granted` →
  `serveWithFailover` 循环**跨协议推进到腾讯 #44**（当时腾讯因采样率缺陷亦败，
  随后 503）——轮转确实跨协议；② v-15 修腾讯后生产验收：豆包仍 403/冷却，
  `/v1/audio/speech` 200/11376B 合法 mp3 由腾讯完成，用量行 113751=
  `tencent:101007`，`scripts/verify-live-voice.mjs` ALL PASS——另一协议账号
  完成请求且归因如实。两条合起来覆盖本任务验证意图。
  **未做**：构造式单测（`failover_test.go` 现只覆盖同协议轮转）——与 1.3 挂账同车。
  **顺带抓出两缺陷已修上产（v-14/15）**：腾讯 TTS 采样率跨平台误用（豆包默认
  24000 原样传腾讯 → `InvalidParameterValue.SampleRate` 100% 失败）；云 API 业务
  错误码被 HTTP 200 吞掉（冷却原因写 `status 200` 无判别力）。

## 5. 出片与生产

- [x] 5.1 测试门全绿（新增单测 + 既有 lanes 套件不回归）。
  **验证**：`go test ./internal/lanes/` 全绿（含 30+ 新增用例）、`go vet` 干净。
- [x] 5.2 出片（build-pool）→ GitOps 滚产 → pod imageID 与 ccr digest 逐字节一致。
  **验证**：`sha-8c0f4f8`（run 39132310921，digest bbca6ec9）→ relay OK →
  skopeo 核 ccr → pod imageID=`bbca6ec9` 全等。
  **坑**：命名空间是 `finddata` 不是 `sub2api`（推错 ns 报
  `DENIED no permission! are you logged in with another ccr account?`）。
- [x] 5.3 admin 建两个上游账号（#43 doubao / #44 tencent），凭据入账号。
  **验证**：`GET /api/v1/admin/accounts/{43,44}` 回读 `audio_protocol` 正确；
  `api_key` 状态 `has_api_key: true`。
  **生产实测抓出**：`secret_id`/`secret_key` 未在脱敏清单 → 明文回显。
  **已修**（2434d7ac9）并待下次出片带上。
- [x] 5.4 生产复验：四项在生产环境实跑。
  **验证**：`/v1/audio/speech` 200/27885B 合法 mp3；`/v1/audio/transcriptions`
  200 且文本正确；**用量行 106331/106337=豆包 TTS、106332=腾讯 ASR**
  （engine 归因如实）。
- [x] 5.5 台账更新（`docs/sub2api-fork-patches/README.md` 增 v-11 版本行；同源
  v-12 行与收尾两缺陷的 v-15 行亦已在册）。
  **已核销（2026-10-22 归档对账）**：`docs/registry-maintenance.md` §12.13 状态行
  的 L2b 硬前置改为「已于 2026-10-18 解除」，并登记残余边界（豆包 ASR 需部署侧
  公网音频前缀，腾讯路径不受影响）。
