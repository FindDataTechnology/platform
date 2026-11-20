# 转写分离能力探针结论（add-speaker-attribution 1.1 / 1.2）

测量时间：2026-11-12（本机，`scripts/probe-diarization.mjs`）
上游：`https://token.finddatatech.cloud`（词元网关）
凭据：部署种子 `LLM_API_KEY`（本机 `.env`，无 `VOICE_API_KEY`、无已绑定词元账号）

## 结论

**上游不提供说话人分离。一期只做 L0（会话身份）+ L2（人工贴名），不做 L1（匿名聚类）。**

依据：六种请在同一个真实音频片段上跑完，**没有任何一种返回说话人字段**；显式要求分离的格式被直接拒绝。

| 请求形状 | 状态 | 说话人字段 | 时间粒度 | 说明 |
|---|---|---|---|---|
| `response_format=json`（平台今天发的） | 200 | 无 | 无 | 只回 `{text}` |
| `response_format=verbose_json` | 200 | 无 | **无** | 收下了这个参数，但没有 `segments`/`words`，仍是纯文本 |
| `verbose_json` + `timestamp_granularities=word` | 200 | 无 | **无** | 粒度参数被忽略 |
| `response_format=diarized_json` | **400** | — | — | 该格式不被支持（不是「支持但空」，是直接拒） |
| `json` + `diarize=true` | 200 | 无 | 无 | 参数被静默忽略 |
| `json` + `speakers=3` | 200 | 无 | 无 | 参数被静默忽略 |

转写本身是好的：同一片段回 `我们先确认预算，然后讨论排期。`，与合成为该音频的文本逐字一致。

## 三种读数逐项

1. **返回形状**：`{ text: string }`。没有 `segments`、没有 `words`、没有 `speaker`/`speaker_id`/`spk` 任何变体
   （`classify()` 会递归扫全 JSON 的键名）。
2. **时间粒度**：**无**。连 `verbose_json` 都不给片级时间戳，所以连「按时间切段」这一层也没有——
   这也解释了 `add-voice-capture-lane` 为什么用**客户端上报的 `start_ms`** 做时间轴，而不是上游时间戳。
3. **单次时长上限**：由平台侧既定限制决定，与分离无关：composer 车道 25 MB / 120 s 超时；
   采集车道单片 8 MB。一小时音频必须切片，这一点在 `add-voice-capture-lane` 已落地。

## 对上游判断的两次翻盘（记录在案）

同一凭据在同一 session 内出现过**两种相反读数**：

- 第一次探针：`/v1/audio/transcriptions` 返回 `401 INVALID_API_KEY`，而同一时刻 `/v1/audio/speech` 返回 200；
  随后连 `/v1/models` 与 speech 也一起 401。
- 几分钟后重跑：全部 200，转写正常。

即网关至少在两条上游之间分发，其中一条的凭据是坏的（本机记忆里「四路中转 / 免费档单账号」同族）。
所以探针把 401/403 判为 **inconclusive 而不是 unsupported**——「问不到」不等于「答案是不」，
这两者混为一谈就会把一个能力无声砍掉。真正把结论钉死的是 200 + 无字段那几行。

**运维含义**：一个没有绑定词元账号的部署，语音输入的成功率取决于网关当时把它分到哪条上游；
这与分离能力无关，但会让「语音时好时坏」看起来像前端 bug。

## 影响面（1.3）

不换转写协议：现有 `/v1/audio/transcriptions` 已经给出可用文本，缺的只是说话人信息，
而现有端点契约在这条路径上零改动（`server/routes/voice.js` 的 `transcribeBuffer` 未变）。
因此不需要另立 change、不需要第二套上游协议。

一期落地范围（据此调整）：

- **做**：L0 会话身份直录归属、L2 人工贴名/改绑/解除 + 留痕、低置信度不派发、如实降级呈现。
- **不做**：L1 匿名聚类（上游无分离结果可聚）、L3 声纹（本能力不提供，且不得默认开启）。
- **呈现**：所有采集一律标注「本场未做分离」，不得凭空生成 `speaker_N`。

## 复跑方法

```bash
node scripts/probe-diarization.mjs        # 人读
node scripts/probe-diarization.mjs --json # 机读（含 failureNames）
```

退出码：`0` 支持或不支持（有定论）、`2` 无定论（无凭据 / 被拒 / 空转写）。
换到一台语音车道正常的部署复跑，若结论变成 `supported`，L1 才重新进入范围。
