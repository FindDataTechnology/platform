# voice-lane Specification

## Purpose

语音车道：壹座以固定的 OpenAI 音频协议经服务端转发到词元语音车道（转写 + 合成），不感知也不配置上游渠道（豆包/腾讯/硅基等差异全在词元侧按账号分派）。转发凭据跟随模型车道（绑定用户的词元 key 优先，部署 key 回落），永不下发浏览器；`voice` 配置块后台可配；语音输入走专用路径插入输入框，回复可朗读。

## Requirements

### Requirement: 语音走固定协议经服务端转发

The platform SHALL expose `POST /api/voice/transcriptions`（multipart `file`）and `POST /api/voice/speech`（JSON `{input}`）and forward them to the 词元 audio lane using the OpenAI-compatible audio protocol only（`/v1/audio/transcriptions`, `/v1/audio/speech`）. The platform SHALL NOT model or configure upstream voice channels（Doubao, Tencent, SiliconFlow…）— channel selection lives on the 词元 side. The forwarding credential SHALL never be delivered to the browser. Uploads over 25 MB SHALL be rejected with 413 before forwarding.

#### Scenario: 转写转发并回文本

- **WHEN** an authenticated user posts an audio file to `/api/voice/transcriptions`
- **THEN** the platform forwards it as multipart to the 词元 ASR endpoint with the configured model（omitted when blank）and returns `{text}` from the upstream JSON

#### Scenario: 合成转发并回音频

- **WHEN** an authenticated user posts `{input}` to `/api/voice/speech`
- **THEN** the platform forwards `{input, model?, voice?, response_format}` to the 词元 TTS endpoint and streams back the upstream audio bytes with the upstream content type

#### Scenario: 超限上传在转发前拒绝

- **WHEN** the uploaded file exceeds 25 MB
- **THEN** the platform answers 413 and makes no upstream request

### Requirement: 转发凭据跟随模型车道

The forwarding key SHALL resolve in order: the requesting user's bound 词元 account key（ciyuan-account）, then the deployment voice key（`VOICE_API_KEY`）, then the deployment model key（`LLM_API_KEY`）. When none resolves the endpoints SHALL answer 503 `voice_not_configured` without an upstream request. An upstream 401/403 while using the user's bound key SHALL mark that binding stale, broadcast the stale event, rewrite the cell credential store, and answer 401 with `connect: {panel: "ciyuan-account"}`. An upstream 401/403 while using a deployment key SHALL answer 502 and SHALL NOT touch any user binding. Other upstream failures SHALL answer 502 with a sanitized message.

#### Scenario: 绑定用户以自己的 key 计费

- **WHEN** the requesting user has a connected 词元 account
- **THEN** the upstream request carries that user's minted key and the usage lands on the user's 词元 account

#### Scenario: 未绑定回落部署 key

- **WHEN** the user has no 词元 binding and `LLM_API_KEY` is set
- **THEN** the upstream request carries the deployment key

#### Scenario: 无任何凭据如实 503

- **WHEN** neither a user binding nor a deployment key exists
- **THEN** the endpoint answers 503 `voice_not_configured` and no upstream request is made

#### Scenario: 用户 key 失效标 stale 并指引

- **WHEN** the upstream answers 401 to a request carrying the user's minted key
- **THEN** the binding is marked stale, the stale event is broadcast, and the response is 401 carrying `connect: {panel: "ciyuan-account"}`

### Requirement: voice 配置块后台可配

The deployment SHALL hold a `voice` configuration block `{enabled, asrModel, ttsModel, ttsVoice, ttsFormat}` resolved as stored deployment config, then the `VOICE_CONFIG` environment seed, then defaults（`enabled: true`, blank models/voice meaning upstream defaults, `ttsFormat: "mp3"`）. Administrators SHALL write it via `PUT /api/config/voice`（partial merge; blank string resets a field）with validation（booleans, strings ≤120 chars, `ttsFormat` in the supported set）. Any client SHALL read `GET /api/voice/status` → `{available, reason, config}` where `available = enabled && key resolvable`, and the boot config SHALL carry `voice: {enabled, ttsFormat}`. No credential SHALL appear in either read.

#### Scenario: 存储优先于环境种子

- **WHEN** `VOICE_CONFIG` sets `asrModel: "a"` and the stored config sets `asrModel: "b"`
- **THEN** the resolved config uses `"b"`

#### Scenario: 坏配置降级而非出错

- **WHEN** the stored `voice` JSON is unparseable or fails validation
- **THEN** resolution falls through to the environment seed（or defaults）with a warning, and the read endpoints still answer 200

#### Scenario: 非管理员不能写

- **WHEN** auth is on and a non-administrator PUTs `/api/config/voice`
- **THEN** the response is 403 and nothing is stored

#### Scenario: 状态读不含密钥

- **WHEN** any authenticated user reads `/api/voice/status`
- **THEN** the body carries `available`, `reason` and the config fields, and no key material

### Requirement: Composer 语音输入走专用路径

The composer SHALL offer a microphone control that records with `MediaRecorder`（start on click, stop on second click）and a dedicated audio-file entry（`accept="audio/*"`）, both sending the audio to `/api/voice/transcriptions` and inserting the returned text into the composer input without auto-sending. The audio path SHALL NOT use the document attachment path. The composer SHALL show the states recording / transcribing / error, tolerate multi-second transcription, and when the error response carries `connect` render a 去连接 action. When voice is unavailable（disabled or no key）the voice entries SHALL NOT render; when the browser lacks `MediaRecorder` only the microphone SHALL hide.

#### Scenario: 录音转写插入输入框

- **WHEN** the user clicks the microphone, speaks, and clicks again
- **THEN** the composer shows transcribing, then the transcript appears appended in the input（space-joined to existing text）and the input is focused; nothing is sent

#### Scenario: 音频文件转写

- **WHEN** the user picks an audio file through the voice file entry
- **THEN** the file goes to `/api/voice/transcriptions`（not to the documents upload）and the text is inserted as above

#### Scenario: 不可用时无入口

- **WHEN** `/api/config` reports `voice.enabled: false` or status reports not available
- **THEN** neither the microphone nor the voice file entry renders

#### Scenario: 转写失败如实显示

- **WHEN** the transcription request fails
- **THEN** the composer shows a sanitized error state and, if the response carries `connect`, a 去连接 action to that panel

### Requirement: 回复可朗读

Each assistant turn with answer text SHALL offer a 朗读 control（when voice is available）that posts the answer text to `/api/voice/speech` and plays the returned audio, with states idle / loading / playing; clicking while playing SHALL stop. Starting one turn's playback SHALL stop any other. Text over 4000 characters SHALL be truncated for synthesis with a visible notice. Failures SHALL surface as a sanitized toast（with 去连接 when `connect` is present）.

#### Scenario: 朗读播放与停止

- **WHEN** the user clicks 朗读 on a finished turn
- **THEN** the control passes loading then playing while the audio plays, and a second click stops playback and returns to idle

#### Scenario: 不可用时不渲染

- **WHEN** voice is not available
- **THEN** no 朗读 control renders on any turn

### Requirement: 模型节提供语音设置

The Models settings section SHALL show a voice card with the current status（available / not configured / disabled and reason）and, for administrators, editable `enabled`, `asrModel`, `ttsModel`, `ttsVoice`, `ttsFormat` fields saved through `PUT /api/config/voice`. Non-administrators SHALL see the status read-only.

#### Scenario: 管理员保存语音配置

- **WHEN** an administrator edits `ttsVoice` and saves
- **THEN** `PUT /api/config/voice` is called, the status refreshes, and the next synthesis carries the new voice

#### Scenario: 非管理员只读

- **WHEN** a non-administrator opens the Models section
- **THEN** the voice card shows status without editable fields
