## MODIFIED Requirements

### Requirement: 语音走固定协议经服务端转发

The platform SHALL expose `POST /api/voice/transcriptions`（multipart `file`）and `POST /api/voice/speech`（JSON `{input}`）and forward them to the 词元 audio lane using the OpenAI-compatible audio protocol only（`/v1/audio/transcriptions`, `/v1/audio/speech`）. The platform SHALL NOT model or configure upstream voice channels（Doubao, Tencent, SiliconFlow…）— channel selection lives on the 词元 side. The forwarding credential SHALL never be delivered to the browser. Uploads over 25 MB SHALL be rejected with 413 before forwarding. The transcriptions endpoint SHALL accept an optional request to return **segments carrying speaker labels**, and SHALL answer with the plain `{text}` shape when that request is absent — the default response MUST remain byte-identical to the pre-change contract.

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
