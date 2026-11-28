# slack-channel Specification

## Purpose
Slack 作为群渠道的接入契约：以 Events API 的 HTTP webhook 收消息、v0 HMAC 签名验请求、
按 Slack 自己的会话结构（thread 优先、回落 channel）决定房间边界，并以 Bot User 的
`chat.postMessage` 把团队的答复写回原处。

## Requirements

### Requirement: 请求来自 Slack 的验证先于任何内容处理

平台 SHALL 在每个 Slack 入站请求上校验 `X-Slack-Signature`：签名 SHALL 为
`v0=` + HMAC-SHA256(signing_secret, `v0:<X-Slack-Request-Timestamp>:<原始请求体>`)。
原始请求体 SHALL 是平台收到的那份字节，MUST NOT 使用重新序列化后的 JSON。
`X-Slack-Request-Timestamp` 与当前时刻相差超过 5 分钟的请求 SHALL 被拒绝。
校验失败的请求 SHALL 以 403 拒绝，且其内容 MUST NOT 进入日志。

#### Scenario: 合法签名放行

- **WHEN** 一个携带正确 `v0` 签名与新鲜时间戳的请求抵达 webhook
- **THEN** 请求被受理，进入解析与回合流程

#### Scenario: 篡改请求体被拒

- **WHEN** 请求体在签名之后被改动一个字节
- **THEN** 请求以 403 被拒，且不产生回合、不记录内容

#### Scenario: 陈旧时间戳按重放拒绝

- **WHEN** 一个签名正确但时间戳早于当前时刻 5 分钟以上的请求抵达
- **THEN** 请求以 403 被拒，且不产生回合

### Requirement: URL 验证握手回显 challenge

`url_verification` 事件 SHALL 在签名校验通过后回显其 `challenge` 值，
MUST NOT 触发任何回合或房间写入。未通过签名校验的握手请求 SHALL 同样以 403 拒绝。

#### Scenario: 握手回显

- **WHEN** Slack 发来一条签名合法的 `url_verification` 请求
- **THEN** 响应体包含该请求的 `challenge` 值，且不产生回合

### Requirement: 会话键按 Slack 的会话结构决定，thread 优先

入站消息的房间键 SHALL 为：事件带 `thread_ts` 时取 `<channel>:<thread_ts>`，
否则取裸 `<channel>`。该键 SHALL 直接作为群桥绑定的会话键，MUST NOT 在桥侧新增第二套解析。
分隔符 SHALL 选取在 channel id 与 ts 中都不出现的字符，使切分无歧义。

#### Scenario: 线程回复落线程房间

- **WHEN** 同一 channel 里两个不同 thread 各收到一条消息
- **THEN** 两者落在两个不同的房间键上，互不串台

#### Scenario: 频道级消息落频道房间

- **WHEN** 一条不带 `thread_ts` 的消息抵达
- **THEN** 其房间键是裸 channel，与任意 thread 房间不同

#### Scenario: 线程内多人共享同一房间

- **WHEN** 同一 thread 里两个不同用户各发一条消息
- **THEN** 两条消息共享同一个房间键

### Requirement: 只有真人正文触发回合

适配器 SHALL 只把携带真人文本的 `message` 事件解析为消息。以下 SHALL NOT 产生回合：
带 `bot_id` 的消息、`subtype=bot_message`、`subtype=message_changed`、
`subtype=message_deleted`、`subtype=channel_join` 等无正文的系统动作，以及正文为空白的消息。
`subtype=thread_broadcast` SHALL 被接受（它是真人在 thread 里发的、同时广播到频道）。

#### Scenario: 机器人回声不回流

- **WHEN** 平台自己的 bot 在频道里发了一条消息
- **THEN** 不产生回合，房间内不会出现这条消息

#### Scenario: 编辑不重复入房

- **WHEN** 一条已入房的消息被编辑，`message_changed` 事件抵达
- **THEN** 不产生回合，房间不出现第二条同内容消息

#### Scenario: 空正文被忽略

- **WHEN** 一条消息只有空白正文
- **THEN** 不产生回合

#### Scenario: 广播到频道的 thread 回复仍算正文

- **WHEN** 一名用户在 thread 里回复并选择同时广播到频道
- **THEN** 该条按其 `thread_ts` 落入 thread 房间并产生回合

### Requirement: 答复写回原处，thread 回复带 thread_ts

出站 SHALL 以 Bot User 的 `chat.postMessage` 投递。房间键带 thread 时 SHALL 同时携带
`thread_ts`，使答复落在原 thread 内；裸 channel 的房间键 SHALL NOT 携带 `thread_ts`。
平台以 HTTP 200 加 `{ok:false, error}` 表达失败，适配器 SHALL 据 `ok` 判定成败并抛出带
平台错误码的错误（MUST NOT 只看 HTTP 状态码）。

#### Scenario: 线程里的答复回到线程

- **WHEN** 一个线程房间产生一条答复
- **THEN** 出站请求带该 thread 的 `thread_ts`

#### Scenario: 频道答复不带 thread

- **WHEN** 一个裸 channel 房间产生一条答复
- **THEN** 出站请求不含 `thread_ts`

#### Scenario: ok:false 视为失败

- **WHEN** Slack 返回 HTTP 200 但响应体 `ok` 为 false（例如 token 被吊销）
- **THEN** 投递被判为失败并抛出含平台错误码的错误，MUST NOT 被当作成功

### Requirement: 凭据与入口表面

Slack 作为一个与既有平台并列的独立 bot 类型接入，凭据 SHALL 为
Bot User OAuth Token（`xoxb-`，机密）与 Signing Secret（机密），并 SHALL 可选接受一个
非机密的 workspace 入口 URL 用于管理面二维码。必填项缺失 SHALL 在保存时以结构化错误拒绝。
该类型 SHALL 出现在平台选择格中，并携带品牌图标与五语显示名。

#### Scenario: 缺签名密钥即拒绝保存

- **WHEN** 运营者只填 Bot Token 就保存一个 Slack bot
- **THEN** 保存被拒并指名缺失 `signingSecret`

#### Scenario: 凭据永不出站

- **WHEN** 任何客户端读取该 bot 的配置
- **THEN** Bot Token 与 Signing Secret 均不以明文出现
