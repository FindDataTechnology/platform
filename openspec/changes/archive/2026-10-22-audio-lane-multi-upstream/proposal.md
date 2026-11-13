# audio-lane-multi-upstream — 语音车道对接豆包语音与腾讯云语音

## Why

词元语音车道（`/v1/audio/transcriptions`、`/v1/audio/speech`）当前只有**一种
上游协议**：OpenAI 兼容 HTTP（`laneUpstreamBaseURL` + `/v1/audio/*` 直连），
且生产池里唯一的 audio 账号（#38，platform=`openainext`）自 2026-10-18 04:16
起持续失败：先是上游 429，随后退化为 `status 0`（连接层失败，网关根本没建立到
`api.openai-next.com` 的 HTTP 请求）。实测 2026-10-18：`POST
/v1/audio/transcriptions` → 503 `lane_upstream_unavailable`。

结果：**语音车道对外 100% 不可用**，下游 L2b（壹座语音输入）被硬前置卡死。

用户已提供两条可用的自有语音上游：

1. **豆包语音（openspeech）** — key 已实测可用，TTS 2.0 与录音文件识别 2.0
   均已开通（免费额度：TTS 20000 字符、流式 ASR 20 小时、录音文件 ASR 20 小时）。
2. **腾讯云语音** — ASR / TTS 均已开通，免费额度至 2027-01-18（TTS 通用 800 万
   字符 / 大模型 10 万 / 超自然 2 万；ASR 按月发放）。

两者的协议形态与现有适配器**完全不同**：

- 豆包 TTS 2.0：WebSocket 双向流式 + **自定义 V3 二进制帧**（nibble 帧头、
  event 编号、session-id 段），音频为裸二进制 mp3 帧。
- 豆包 ASR 2.0：**异步任务**（`POST /api/v3/auc/bigmodel/submit` 提交 +
  `POST /api/v3/auc/bigmodel/query` 轮询），需公网可达音频 URL。
- 腾讯云：云 API 3.0 REST + TC3-HMAC-SHA256 签名，`TextToVoice` 返回 Base64
  音频，ASR 分一句话识别（同步）与录音文件识别（异步任务）。

## 本次探针实证（2026-10-18，真 key 真音频）

**豆包 TTS 2.0 全链路已打通**：真文本 → 22913 字节合法 mp3
（`file` 判读：ID3 v2.4 / MPEG ADTS layer III / 64 kbps / 24 kHz / 单声道）。
协议细节全部从官方文档取实并逐条验证：

| 要点 | 正确形态（实测） | 我最初的错误假设 |
|---|---|---|
| 帧头 | 逐字节 nibble：`[0]` 高 4 位=版本(1) 低 4 位=header size(1) | 16 字节大端整型头 |
| 帧结构 | `4B header + 4B event + [4B sidLen+sid] + 4B payloadLen + payload` | 缺 session_id 段 |
| `event` 字段 | **int32**（传字符串被拒） | 字符串 |
| 音频帧 | **裸二进制 mp3**（serialization nibble=0） | base64 文本 |
| Audio-only 帧 | payload = `uint32(sidLen)+sid+audio`，**无外层 payload size** | 与 full 帧同构 |
| 2.0 音色 | `*_uranus_bigtts`（如 `zh_female_shuangkuaisisi_uranus_bigtts`） | 1.0 的 `*_moon_bigtts` |

首个音频 chunk 前置 4 字节为 ID3 标签长度（`0000092d`=2349），剥掉后即从
`ID3` 起始的标准 mp3。

**豆包 ASR 2.0 全链路已打通**：真实英文语音 URL → 10 句完整转写、9 个
utterance、`duration=33621`ms，与输入音频精确对应。注意 `volc.seedasr.auc`
需在控制台单独开通（开通前回 `45000030 requested resource not granted`）。

**腾讯云凭据受阻**：`SecretId` 有效（服务端回 `SignatureFailure` 而非
`SecretIdNotFound`），但 `SecretKey` 为 **29 字符**（腾讯云标准 32 字符），且
真实 Key 与随机伪造 Key 返回**完全相同**的错误——判定为 SecretKey 不完整。
**凭据补齐前腾讯云适配器不得出片**。

## What Changes

- **audio 车道改为按上游协议分派**：账号凭据新增 `audio_protocol` 字段
  （`openai` | `doubao` | `tencent`），适配器按候选账号的协议选择实现；
  未标注时回落 `openai`（向后兼容现有 #38 与硅基账号）。
- **新增豆包语音适配器**：V3 帧编解码（TTS 双向流式）+ 异步任务式 ASR
  （提交/轮询）。同一车道内该协议只处理自己那部分候选。
- **新增腾讯云适配器**：TC3-HMAC-SHA256 签名 + `TextToVoice`（同步返回
  Base64）+ 一句话识别/录音文件识别。
- **对外契约不变**：`/v1/audio/transcriptions`、`/v1/audio/speech` 的请求与
  响应形状保持 OpenAI 兼容——调用者不因换上游而改造（既有 spec 要求）。
- **`LaneEngine` 改为按实际选中的账号标注**：现在硬编码 audio→`openainext`，
  多上游后需按账号 `audio_protocol` 如实标注，否则用量行归因错误。
- **ASR 任务态**：豆包/腾讯的录音文件识别是异步任务，适配器需在请求内完成
  提交+有限轮询，超时则如实报错（不静默成功）。

## Capabilities

### Modified Capabilities

- `ciyuan-gateway-lanes`: 语音车道的「上游供应商可插拔」从「同一 OpenAI 兼容
  协议换 base_url」扩展为「**跨协议**可插拔」——audio 车道 SHALL 支持
  OpenAI 兼容 / 豆包 openspeech / 腾讯云云 API 三种上游协议，并按账号标注
  分派；对外契约（请求/响应形状、计量单位、错误面）不变。

## Impact

- **代码**：`backend/internal/lanes/`（新增 `audio_doubao.go`、
  `audio_tencent.go`、帧编解码与 TC3 签名辅助；改 `audio.go` 为分派器、
  `errors.go` 的 `LaneEngine`）。
- **谱系纪律**：全部为 fork 新增文件 + 已有 fork 文件内改动，**不触碰上游文件**，
  缝点集合不变。
- **账号配置**：需在 admin 建两个新平台账号（`doubao` / `tencent`），凭据含
  `audio_protocol` 与各自密钥；豆包的 TTS 资源 ID、腾讯云的 SecretId/Key
  均落账号凭据（admin 脱敏读取）。
- **计量**：ASR 仍按音频时长（小时）、TTS 仍按合成字符数（百万字符）——
  两者都能从上游拿到对应数据（豆包 ASR 返回 `duration`；
  腾讯云 TTS 按 `Text` 长度；豆包 TTS 可要求返回 `text_words` 用量）。
- **无破坏性变更**：现有 `openai` 协议账号行为不变。
- **前置**：腾讯云 SecretKey 需补齐（32 字符）后方可实测出片。
