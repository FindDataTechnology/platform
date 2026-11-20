# voice-lane Specification

## Purpose

语音车道：壹座以固定的 OpenAI 音频协议经服务端转发到词元语音车道（转写 + 合成），不感知也不配置上游渠道（豆包/腾讯/硅基等差异全在词元侧按账号分派）。转发凭据跟随模型车道（绑定用户的词元 key 优先，部署 key 回落），永不下发浏览器；`voice` 配置块后台可配；语音输入走专用路径插入输入框，回复可朗读。

## Requirements

### Requirement: 语音走固定协议经服务端转发

The platform SHALL expose `POST /api/voice/transcriptions`（multipart `file`）and `POST /api/voice/speech`（JSON `{input}`）and forward them to the 词元 audio lane using the OpenAI-compatible audio protocol only（`/v1/audio/transcriptions`, `/v1/audio/speech`）. The platform SHALL NOT model or configure upstream voice channels（Doubao, Tencent, SiliconFlow…）— channel selection lives on the 词元 side. The forwarding credential SHALL never be delivered to the browser. Uploads over 25 MB SHALL be rejected with 413 before forwarding. The transcriptions endpoint SHALL accept an optional request to return **segments carrying speaker labels**, and SHALL answer with the plain `{text}` shape when that request is absent — the default response MUST remain byte-identical to the pre-change contract.

The forwarded audio SHALL be a **complete, self-describing file** in a container the lane accepts. Measured against the production lane on 2026-11-15, the accepted set is WAV/PCM, MP3, and non-fragmented MP4/AAC; the rejected set is WebM/Matroska, OGG, and fragmented MP4（`empty_moov`）. Because the lane removes the audio account from rotation for roughly a minute after a rejected-content response — degrading transcription for **every** caller, not just the one who uploaded — the platform SHALL recognise a container in the rejected set and answer `415 unsupported_audio_container`（naming the accepted formats）**without** making an upstream request. A blank `asrModel` SHALL continue to omit the model field, which the lane accepts.

#### Scenario: 转写转发并回文本

- **WHEN** an authenticated user posts an audio file to `/api/voice/transcriptions` without asking for segments
- **THEN** the platform forwards it as multipart to the 词元 ASR endpoint with the configured model（omitted when blank）and returns `{text}` from the upstream JSON, exactly as before

#### Scenario: 转写请求分段时透传说话人标签

- **WHEN** the caller asks for segments and the upstream returns segmented output with speaker labels
- **THEN** the response carries the ordered segments（每段含起止偏移与说话人标识）alongside the whole text, and no label is invented where the upstream supplied none

#### Scenario: 上游无分段能力

- **WHEN** the caller asks for segments but the upstream answers with a single plain text
- **THEN** the platform returns the text successfully with one segment whose speaker is「未知」, and never fails the request over the missing labels

#### Scenario: 合成转发并回音频

- **WHEN** an authenticated user posts `{input}` to `/api/voice/speech`
- **THEN** the platform forwards `{input, model?, voice?, response_format}` to the 词元 TTS endpoint and streams back the upstream audio bytes with the upstream content type

#### Scenario: 超限上传在转发前拒绝

- **WHEN** the uploaded file exceeds 25 MB
- **THEN** the platform answers 413 and makes no upstream request

#### Scenario: 车道拒收的容器不打上游

- **WHEN** the uploaded bytes are a WebM/Matroska, OGG, or fragmented-MP4 container
- **THEN** the platform answers `415 unsupported_audio_container` naming the accepted formats, and makes **no** upstream request — so the shared audio account is not taken out of rotation and other callers keep transcribing

#### Scenario: 空 model 是规格内行为

- **WHEN** `asrModel` is blank and the caller posts a WAV file
- **THEN** the request is forwarded without a `model` field and the lane transcribes it normally（2026-11-15 实测：`{"text":"这是会议测试，请记录这一路。"}`）

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

The composer SHALL offer a talk control that records with the **client platform's own recorder**（web：`MediaRecorder`；小程序：`RecorderManager`；移动端：原生录音器）and a dedicated audio-file entry（`accept="audio/*"`）, both sending the audio to `/api/voice/transcriptions` and inserting the returned text into the composer input without auto-sending. On web the recorded artifact, the interaction（click to start, click to stop）and the state transitions SHALL remain exactly as before.

The audio path SHALL NOT use the document attachment path on any client. The composer SHALL show the states recording / transcribing / error, tolerate multi-second transcription, and when the error response carries `connect` render a 去连接 action. When voice is unavailable（disabled or no key）the voice entries SHALL NOT render on any client; when the client's recorder is unavailable only the talk control SHALL hide and the audio-file entry SHALL stay.

Recording SHALL be cancelable, and a cancelled recording SHALL produce no upload and no insertion. The client SHALL validate the artifact's duration and container **before** uploading: an artifact that would exceed the platform upload limit or uses an unsupported container SHALL be refused locally with a readable reason and no request SHALL be sent. Leaving the page or backgrounding the app while transcribing SHALL NOT leave the control stuck: on return the control SHALL either resume the pending state or land in an honest error state.

A single cross-client state machine SHALL govern the control（idle / requesting / recording / transcribing / error），shared by all clients, and each client SHALL plug in only a recorder adapter — the three clients MUST NOT each carry their own copy of the transition logic.

#### Scenario: 录音转写插入输入框

- **WHEN** the user starts recording, speaks, and stops
- **THEN** the composer shows transcribing, then the transcript appears appended in the input（space-joined to existing text）and the input is focused; nothing is sent

#### Scenario: 音频文件转写

- **WHEN** the user picks an audio file through the voice file entry
- **THEN** the file goes to `/api/voice/transcriptions`（not to the documents upload）and the text is inserted as above

#### Scenario: 不可用时无入口

- **WHEN** `/api/config` reports `voice.enabled: false` or status reports not available
- **THEN** neither the talk control nor the voice file entry renders

#### Scenario: 转写失败如实显示

- **WHEN** the transcription request fails
- **THEN** the composer shows a sanitized error state and, if the response carries `connect`, a 去连接 action to that panel

#### Scenario: 小程序按住说话

- **WHEN** 用户在小程序聊天页按住说话控件、说话、松手
- **THEN** 控件进入 transcribing，随后转写文本追加进输入框且不自动发送

#### Scenario: 移动端按住说话

- **WHEN** 用户在 App 聊天页按住说话控件、说话、松手
- **THEN** 与小程序同样的状态序列与插入语义，输入框获得焦点

#### Scenario: 取消录音零副作用

- **WHEN** 用户在录音过程中滑动或点击取消
- **THEN** 录音停止并被丢弃，不发起任何转写请求，输入框内容不变

#### Scenario: 超限或格式不支持时本地拒绝

- **WHEN** 录音时长换算后的体积超过平台上传上限，或录音器只能产出不受支持的容器
- **THEN** 客户端在上传前给出可读原因，不发起请求（不产生必然失败的网络往返）

#### Scenario: 转写中切后台

- **WHEN** 用户在 transcribing 状态切换到后台并返回
- **THEN** 控件不停留在 transcribing，而是恢复为待确认状态（有结果则插入、无结果则如实报错）

#### Scenario: 录音器缺失时只隐藏说话控件

- **WHEN** 客户端没有可用的录音器（权限或平台不支持），而语音服务本身可用
- **THEN** 只有说话控件不渲染，音频文件入口仍然渲染并可用

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

### Requirement: 移动端录音先取授权，被拒后给出可走的路

移动端 SHALL 在首次录音前请求录音权限。授权被拒时 SHALL NOT 反复触发系统授权框；SHALL 以可读说明
告知「语音输入需要录音权限」，并 SHALL 提供一条可执行的下一步（前往设置或改用音频文件入口）。
未获得授权时 SHALL NOT 进入录音态，也 SHALL NOT 产生任何上传。

权限状态 SHALL 在页面内被重新读取：用户从设置返回后，无需重启小程序/App 即可恢复录音入口。

#### Scenario: 首次录音请求授权

- **WHEN** 用户首次点击说话控件
- **THEN** 客户端请求录音权限，获准后进入录音态

#### Scenario: 被拒后不再弹系统框

- **WHEN** 用户此前拒绝了录音权限并再次点击说话控件
- **THEN** 不弹出系统授权框，改为呈现可读说明与下一步动作，不进入录音态

#### Scenario: 从设置返回后恢复

- **WHEN** 用户在系统设置中开启录音权限后返回应用并再次点击
- **THEN** 无需重启即可进入录音态

### Requirement: 三端转写走同一协议，不在客户端分叉

小程序与移动端 SHALL 使用与 web 相同的 `/api/voice/transcriptions`（multipart `file`）与
`/api/voice/status`，MUST NOT 为某一端新增转写端点或修改请求形状。客户端 SHALL 依据
`/api/voice/status` 的 `available` 与 `reason` 决定是否渲染入口，MUST NOT 自行猜测可用性。

#### Scenario: 同一端点三端共用

- **WHEN** 小程序、App 与 web 各发起一次转写
- **THEN** 三者命中同一端点、同一字段名与同一响应形状，服务端无需按端分支

#### Scenario: 状态读决定入口

- **WHEN** 语音服务未配置凭据，`/api/voice/status` 返回不可用
- **THEN** 三端都不渲染任何语音入口
