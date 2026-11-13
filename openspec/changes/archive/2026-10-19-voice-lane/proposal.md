# voice-lane — 语音输入与回复朗读（L2b）

## Why

用户要能**说**给壹座听、也能**听**壹座念回复。词元侧语音车道已多上游落地
（`audio-lane-multi-upstream`，ciyuan-v0.2.16-13）：对外契约固定为 OpenAI 音频协议
（`POST /v1/audio/transcriptions` multipart ASR；`POST /v1/audio/speech` JSON→二进制 TTS），
2026-10-18 生产复验两适配器（腾讯 ASR / 豆包 TTS）200 且用量归因如实；
本次立项前又以 **group-3 铸造 key（壹座绑定用户同款凭据）单探针**实打：
ASR 200/3.5s 真转写文本、TTS 200/1.2s 合法 mp3——硬前置确凿解除。

用户对 L2b 的定调（2026-10-18）：**后台配置驱动，壹座只说固定格式**——渠道
（TTS/ASR 上游）在词元侧配置，壹座侧只面向固定协议，不感知豆包/腾讯差异。

壹座侧三个既有阻断点使语音**不能**走文档附件路径：`documents.js` 的 `EXT_TYPE_MAP`
拒绝音频（415）、readers 无音频抽取器、composer 文件输入无 `accept`。因此语音走
**专用输入路径**，与 RAG 附件彻底分流。

## What Changes

- **服务端转发（key 不出服务端）**：新 `server/routes/voice.js`
  - `POST /api/voice/transcriptions`：multipart `file` 转发 → 词元 ASR，回 `{text}`；
  - `POST /api/voice/speech`：`{input}` 转发 → 词元 TTS，回二进制音频；
  - key 解析跟随模型车道：绑定用户的铸造 key 优先（计费到用户词元账号），
    回落部署 key；两者皆无 → 503 `{error:"voice_not_configured"}`；
  - 上游 401/403：用户 key → 标 stale + 广播 stale 事件 + 回 401 带 `connect:{panel:"ciyuan-account"}`（与 chat-connect-guidance 同形）；
  - 上游 5xx/网络 → 502 脱敏文案；上传 >25MB → 413。
- **voice 配置块（后台可配）**：deployment_config `voice`（JSON）→ env `VOICE_CONFIG` 种子 → 默认值；
  `{enabled:true, asrModel:"", ttsModel:"", ttsVoice:"", ttsFormat:"mp3"}`，空模型字段=用上游默认；
  `GET /api/voice/status`（登录可读，不含密钥）+ `PUT /api/config/voice`（admin 门，
  同 branding 模式）；`GET /api/config` 附带 `voice`。
  上游地址 `VOICE_API_BASE` → 回落 `CIYUAN_API_BASE` → 默认生产网关；转发 key `VOICE_API_KEY` → 回落 `LLM_API_KEY`。
- **Composer 语音输入**：麦克风按钮（MediaRecorder，`composer-voice-mic`，录音中再点停止即转写）+
  专用音频文件入口（`composer-audio-input`，`accept="audio/*"`，在 `+` 菜单加「语音转文字」项）；
  状态机 idle/recording/transcribing/error，「转写中」chip 容忍秒级等待（豆包 ASR 异步在词元侧内部消化）；
  转写文本**插入 composer 输入框**（不自动发送）；voice 不可用时不渲染入口。
- **回复朗读**：AssistantTurn 动作区「朗读」按钮（`turn-speak`，idle/loading/playing 三态，
  再点停止），按配置的 tts 模型/音色/格式合成，blob 播放；错误 toast 脱敏。
- **设置·模型节 VoiceCard**（admin）：enabled 开关 + asrModel/ttsModel/ttsVoice/ttsFormat 表单，
  保存 PUT `/api/config/voice`，实时显示当前 status。
- **测试**：单测 `scripts/test-voice-lane.mjs`（假音频服务，可编程 ASR/TTS/401/502 模式，
  断言转发鉴权用绑定 key、回落 env key、配置解析存储>env>默认、admin 门、密钥零外泄）；
  e2e `e2e/voice.spec.js`（假服务挂 `/v1/audio/*`；音频文件→转写插入；朗读按钮真请求真 mp3；
  麦克风路径用 chromium 假媒体设备跑通）。

## Non-goals

- 不做流式 ASR/TTS、不做实时语音对话；不做说话人分离/时间戳；不进知识库 RAG。
- 不在前端直连词元（密钥永不下发浏览器）；不做本地转写兜底。

## Impact

- 新文件：`server/routes/voice.js`、`web/src/components/llm/VoiceCard.tsx`、
  `scripts/test-voice-lane.mjs`、`e2e/voice.spec.js`、mp3 fixture。
- 改动：`server/routes/app.js`（注册）、`server/routes/misc.js`（config 附带 voice）/
  `db.js`（无迁移，deployment_config 既有表）、`web/src/components/Composer.tsx`、
  `web/src/components/AssistantTurn.tsx`、`web/src/pages/ModelsPage.tsx`、
  `packages/core/src/api/extensions-api.ts`（客户端 API）、`e2e/ciyuan-stub.js`（音频端点）、
  `playwright.config.js`（假媒体设备 flag）、i18n 五语言。
- 生产出片后真机验收：绑定用户发一条真实语音→转写插入；朗读一条回复→出声。
