# voice-lane — 设计

## D1 固定协议、服务端转发、密钥不下浏览器

壹座只说 OpenAI 音频协议这一种话；豆包/腾讯/硅基等上游差异全部在词元侧按账号
`audio_protocol` 分派（audio-lane-multi-upstream）。壹座不感知、不配置渠道。

浏览器永远只打 `/api/voice/*`；服务端持 key 转发。理由与 L2a 一致：铸造 key 是
用户的计费凭据，不能进前端 bundle / network 面板。

| 入站（浏览器→壹座） | 出站（壹座→词元） |
|---|---|
| `POST /api/voice/transcriptions` multipart `file`（≤25MB） | `POST {base}/v1/audio/transcriptions` multipart `file` + 配置的 `model`（空则不传，用上游默认） + `response_format=json` |
| `POST /api/voice/speech` JSON `{input}` | `POST {base}/v1/audio/speech` JSON `{input, model?, voice?, response_format}` |

超时：ASR 120s（豆包 ASR 在词元侧是提交+轮询的异步任务，词元侧 client 也是 120s）；TTS 60s。
文件名原样透传（上游按扩展名判格式）；浏览器 MediaRecorder 产物命名 `recording.webm`
（Safari 回落 `audio/mp4` → `recording.m4a`）。

## D2 key 解析跟随模型车道

```
key = ciyuanAccount.liveToken(identity(req).email ?? ctx.cellUserEmail)
   ?? process.env.VOICE_API_KEY
   ?? process.env.LLM_API_KEY
   ?? null → 503 voice_not_configured
```

- 绑定用户：铸造 key → 用量落到用户词元账号（L2a 的计费主体承诺延伸到语音）。
- 未绑定：部署 key（生产模型真源是 `LLM_API_KEY`，见 §12.17 第二轮教训——
  这里直接读它，不再引第三个名字；`VOICE_API_KEY` 留作部署想分开计费时的开关）。
- 上游 base：`VOICE_API_BASE` → `CIYUAN_API_BASE` → `https://token.finddatatech.cloud`
  （生产 pod 已经从这个地址做账号绑定，可达性已证）。

上游 401/403 且用的是用户 key → `ciyuanAccount.markStale(email)` + `ctx.broadcast({type: staleEvent})`
+ 重写 cell 凭据存储（复用 `rewriteModelLane` 同款 `ensureCredentialsStore`）→ 回 401
`{error, connect:{panel:"ciyuan-account"}}`。部署 key 失效 → 502（部署问题，不标 stale）。

## D3 配置块：存储 > env > 默认，admin 可写

沿用 branding 的 deployment_config 模式，一把 JSON 键 `voice`：

```json
{ "enabled": true, "asrModel": "", "ttsModel": "", "ttsVoice": "", "ttsFormat": "mp3" }
```

- 解析顺序：`db.getDeploymentConfig("voice")`（JSON 字符串）→ `process.env.VOICE_CONFIG` → 默认。
  坏 JSON / 校验失败 → 告警并降级到下一层（同 loginHero 的「不让坏配置弄垮页面」）。
- 校验：`enabled` 布尔；三个模型字符串 ≤120 字符、空串=上游默认；`ttsFormat ∈ {mp3, wav, opus, aac, flac}`。
- `PUT /api/config/voice`：admin 门（auth 开时），部分字段合并，`""` 清回默认；
  `GET /api/voice/status`：登录可读，回 `{available, reason, config}`——
  `available = config.enabled && key 可解析`，`reason ∈ {disabled, no_key}`；**不含任何密钥**。
- `GET /api/config` 附 `voice: {enabled, ttsFormat}`（启动时 composer 就能决定渲不渲染入口，
  状态细节再问 status）。

## D4 Composer：专用路径，与附件分流

- 麦克风按钮 `composer-voice-mic`：`navigator.mediaDevices.getUserMedia({audio:true})` →
  `MediaRecorder`（优先 `audio/webm;codecs=opus`，不支持回落 `audio/mp4`）；点一下开录
  （按钮红点脉冲，`data-state=recording`），再点停止 → 合成 Blob → `POST /api/voice/transcriptions`
  → `data-state=transcribing`（chip「转写中…」）→ 文本插入输入框末尾（已有文本则空格衔接）、
  聚焦；错误 → chip 显示脱敏文案，若响应带 `connect` 则 chip 内放「去连接」。
- 音频文件入口：独立隐藏 `<input type=file accept="audio/*" data-testid="composer-audio-input">`，
  `+` 菜单加「语音转文字」项触发；**不走 `attachFiles`**（那条路是文档/RAG，415 会拒）。
- 不可用（`/api/config.voice.enabled=false` 或 status 不 available）→ 不渲染麦克风与菜单项；
  浏览器无 `MediaRecorder` → 只隐藏麦克风，保留文件入口。
- 权限被拒 → chip 文案「麦克风权限被拒绝」，不进 error 循环。

## D5 朗读：按回合、单播放器

- AssistantTurn 动作区加 `turn-speak`（与 copy/regenerate 同排），仅 `answerText` 非空且 voice 可用时渲染。
- 三态 `data-state`：`idle` → 点击 `loading`（POST speech）→ `playing`（`HTMLAudioElement` 播 blob URL）→ 结束回 `idle`；
  `playing` 时再点 = 停止。全局单例播放器（模块级 ref）：开始新的先停旧的。
- 文本取 `answerText`（与复制按钮同源，已去掉机械块）；超过 4000 字截断并提示（上游 TTS 按字符计费，
  词元 speech 读体上限 4MB）。
- 失败 → toast 脱敏；401 带 connect → toast 文案附「去连接」。

## D6 设置·模型节 VoiceCard

`ModelsPage` providers 列表下方加 `VoiceCard`（admin 可编辑，非 admin 只读状态）：
status 行（可用/未配置/已停用 + 原因）、enabled 开关、四个文本字段、保存。
保存走 `PUT /api/config/voice`，成功后刷新 status。testid `voice-card`/`voice-card-*`。

## D7 测试策略

- 单测 `scripts/test-voice-lane.mjs`：起假音频服务（`createVoiceStub()`，模式可编程：
  asr `ok|401|502`，tts `ok|502`），起真 express 应用挂路由，用 fake ctx
  （`cellUserEmail`、`broadcast` 捕获、`authEnabled`）。断言：
  ① 绑定用户 → 上游收到 `Bearer <minted>`；② 未绑定 → `Bearer <LLM_API_KEY>`；③ 皆无 → 503；
  ④ 上游 401 用户 key → markStale + broadcast + 响应带 connect；⑤ 上游 502 → 502 脱敏且 stale 不动；
  ⑥ 配置：存储 > env > 默认、坏 JSON 降级；⑦ PUT 非 admin 403、校验拒坏 format；
  ⑧ console 捕获证密钥零日志；⑨ >25MB → 413。
- e2e `e2e/voice.spec.js`：`ciyuan-stub` 挂 `/v1/audio/transcriptions`（回固定文本）与
  `/v1/audio/speech`（回提交入库的 ≤2KB 真实静音 mp3 fixture）；
  ① `setInputFiles(composer-audio-input, tiny.wav)` → 转写 chip → 输入框含固定文本；
  ② 发一轮 → `turn-speak` 点击 → `data-state` 经 loading 到 playing（chromium 启动
  `--autoplay-policy=no-user-gesture-required`）；③ 麦克风：`--use-fake-device-for-media-stream`
  + `grantPermissions(["microphone"])` → 点录→点停→chip→文本插入；④ voice disabled 时入口不渲染。
- 真机：`scripts/verify-live-voice.mjs`——真 Logto 账号 + 绑定词元 trial → 上传真 wav →
  转写文本非空；朗读 → `/api/voice/speech` 200 且 `audio/mpeg`；词元 `usage_logs` 该 key 出现
  audio 车道用量行（计费主体=用户）。
