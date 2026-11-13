# audio-lane-multi-upstream — Design

## 背景：为什么不能「换个 base_url」

现有 audio 适配器把「上游」抽象成 `base_url` + OpenAI 兼容路径
（`audio.go:271` 拼 `laneUpstreamBaseURL(account) + /v1/audio/transcriptions`）。
这个抽象对硅基/openai-next 成立，对本次两条上游**不成立**：

| 上游 | TTS 协议 | ASR 协议 | 能否复用 base_url 抽象 |
|---|---|---|---|
| OpenAI 兼容 | `POST /v1/audio/speech` JSON→二进制 | `POST /v1/audio/transcriptions` multipart | ✅ |
| 豆包 openspeech | **WebSocket 双向流 + V3 二进制帧** | **异步任务**（submit + query） | ❌ |
| 腾讯云 | 云 API 3.0 REST + TC3 签名，`TextToVoice` 返回 Base64 | 一句话识别（同步）/ 录音文件（异步任务） | ❌ |

因此本 change 的核心是把「协议」从适配器内部假设提升为**账号级可标注属性**。

## D1 — 协议分派放在哪一层

**决定：账号凭据 `audio_protocol` 字段 + 适配器内分派（不改 router/pool）。**

理由：

- `Pool.Candidates(platform)` 按 platform 取候选，一个车道一个 platform 的
  现结构（`router.go:53`）不需要动——豆包/腾讯各自注册独立 platform
  （`doubao` / `tencent`），`Candidates` 仍只返回该平台候选。
- 但**一个车道现在可能同时有多个平台的账号**（例如豆包 TTS 可用而腾讯云
  TTS 更便宜）。此时单次请求的候选集合应跨平台，失败才能真轮转。
  **故需要一次 `router.go` 的扩大取号范围**：audio 车道改为取
  「全部具备 audio 能力的账号」，按 priority 归并。
- 分派依据必须落在账号上（而非全局配置），否则同车道无法混布多协议。

**实现要点**：

1. `service.Account.Credentials` 新增可选键 `audio_protocol`
   （`openai`|`doubao`|`tencent`），缺省回落 `openai`。
2. `audio.go` 的 `Serve` 改为：按候选账号的 `audio_protocol` 选实现，
   每个实现只处理自己协议族的候选；某协议族候选耗尽则按既有
   `serveWithFailover` 语义继续下一个候选（跨协议轮转）。
3. `LaneEngine(lane)` 增加按账号解析的重载
   `laneEngineForAccount(lane, account)`，用量行与错误体用实际命中的账号标注。

**替代方案（否决）**：把豆包/腾讯各自做成独立车道
（`/v1/audio/doubao/*`）。否决理由——违反既有 spec 的「换上游供应商
调用者零改造」，且会把上游实现细节泄露到对外契约。

## D2 — 豆包 V3 帧编解码

**决定：在 fork 新增 `audio_doubao.go` 内实现，不引入第三方库。**

帧结构（实测，与官方文档一致）：

```
[0] version(4bit)|header_size(4bit)     // 1|1
[1] msg_type(4bit)|flags(4bit)          // 1|4 for client event frames
[2] serialization(4bit)|compression     // 1|0 = JSON, no compression; 0|0 = raw audio
[3] reserved
[4..7]  event (int32 BE)
-- session 类事件（StartSession/FinishSession/TaskRequest）额外带:
[8..11]   len(session_id)
[12..]    session_id
[+4]      len(payload)
[..]      payload
-- Audio-only 响应帧（msg_type=0xB）:
[8..11]   len(session_id)
[12..]    session_id
[..]      裸音频字节（无外层 payload size）
```

**关键实测约束**（写实现时逐条守住）：

- `event` 字段必须是 **int32**；传字符串服务端直接 422/错误帧。
- 音频帧 serialization nibble = **0（raw）**，不是 base64；base64 只出现在
  HTTP 单向流式那条线（不同的端点，不要混）。
- 2.0 音色必须 `*_uranus_bigtts`；用 1.0 的 `*_moon_bigtts` 会回
  `resource ID is mismatched with speaker related resource`。
- 首个音频 chunk 前置 4 字节为 ID3 标签长度，需剥掉后从 `ID3` 起始拼接。
- 事件序列：`StartConnection(1)` → 收 `ConnectionStarted(50)` →
  `StartSession(100)` → 收 `SessionStarted(150)` → `TaskRequest(200)` →
  `FinishSession(102)` → 收 `SessionFinished(152)`。

**超时与并发**：WebSocket 单连接串行处理一次合成；适配器内按请求建立连接
（v1 不做连接复用——先正确后优化，复用列入后续）。

## D3 — 豆包 ASR 是异步任务

**决定：在适配器内做「提交 + 有限轮询」，设总时长上限，超时如实报错。**

流程：`POST /api/v3/auc/bigmodel/submit`（拿 20000000 即受理）→
轮询 `POST /api/v3/auc/bigmodel/query`（带同一 `X-Api-Request-Id`）→
`result.text` 即转写。

**约束**：

- 上游要求 `audio.url`（**公网可达 URL**），不接受直接 POST 文件字节。
  这对「调用者上传文件」的现有契约是个真实缺口：需先把文件落到可公开访问的
  存储，或改用「流式语音识别 2.0」（WebSocket，支持流式送音频）。
  **v1 决定**：走录音文件识别 + 内置临时存储（对象存储或本机静态目录），
  并在 spec 里显式记该约束；不假装同步。
- 轮询必须有上限（建议总 120s，间隔 1s 递增），超时返回车道级 5xx 且不计费。

## D4 — 腾讯云签名

**决定：手写 TC3-HMAC-SHA256（官方 Node SDK 在 Go 侧不可用），并用官方
SDK 的行为做金样对照。**

实测中手写签名与官方 SDK 对同一把（不完整的）key 返回了**相同**的
`AuthFailure.SignatureFailure`，证明手写实现路径正确。实现时保留该对照测试。

**凭据形态**：`SecretId` + `SecretKey`（+ 可选 `Token`）。落账号
`credentials`，**禁止**写入源码或前端；日志不得出现明文。

## D5 — 计量口径

| 能力 | 上游可用数据 | 计量单位 |
|---|---|---|
| 豆包 TTS | 请求 `X-Control-Require-Usage-Tokens-Return: *` 可返回 `text_words` | 百万字符 |
| 豆包 ASR | `query` 返回 `audio_info.duration`（ms） | 小时 |
| 腾讯 TTS | 本地 `Text` 长度（UTF-8 字符） | 百万字符 |
| 腾讯 ASR | 一句话：本地音频时长；录音文件：`ResultDetail` 含时长 | 小时 |

全部复用既有 Group 音频三价字段（`STT` 每小时 / `TTS` 每百万字符），
**不新增价目字段**——与 rerank 那个需要新字段的先例不同。

## D6 — 腾讯云 ASR 的两种形态

**决定：v1 只接「一句话识别」（同步）**，录音文件识别（异步，同豆包 D3）
列为后续。理由——壹座语音输入的主场景是短语音（麦克风按住说话），
一句话识别 ≤60s 覆盖该场景且是同步的，实现与验证成本最低；
录音文件识别留待长音频需求出现。

## Risks

| 风险 | 应对 |
|---|---|
| 豆包 WebSocket 在生产网络的稳定性（长连接、代理） | 先用单请求单连接；失败按瞬态冷却换号；观测失败率再谈复用 |
| 豆包 ASR 需要公网 URL，引入存储依赖 | v1 用临时静态目录 + 短时效；在 spec 记为已知约束 |
| 腾讯云 SecretKey 当前不完整 | 凭据补齐前**不得出片**；以金样测试门卡住 |
| 跨协议轮转可能引入难以复现的混合失败 | 每个协议族独立单测 + 金样；冷却/失败分级沿用既有判据 |
