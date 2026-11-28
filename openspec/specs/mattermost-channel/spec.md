# mattermost-channel Specification

## Purpose
TBD - created by archiving change add-mattermost-channel. Update Purpose after archive.

## Requirements

### Requirement: 同一凭据同时承担入流与出流

Mattermost 通道 SHALL 使用 bot 账号的 personal access token 既接收频道消息又发送回答，
MUST NOT 要求运营者为收、发两条方向分别维护两套独立凭据。

该通道的出流能力 SHALL 声明为「凭据随请求走、无调用方地址白名单」这一档——
它不因出口地址变化而失效，这是它与既有企业微信两条腿的根本区别。

#### Scenario: 同一个 token 收发

- **WHEN** 运营者填入一个 bot 账号的 access token
- **THEN** 入站消息可被接收，且回答可经同一 token 发出

#### Scenario: 出口地址变化不影响发送

- **WHEN** 平台进程的出口地址发生变化
- **THEN** 发送仍然成功，MUST NOT 出现「来源不被接受」类失败

### Requirement: 入站有两种形态，按部署条件选择，且只启用一种

通道 SHALL 支持两种入站形态：

- **主动连接**（websocket）：进程主动连向实例订阅事件，不需要实例能反向访问本进程。
- **回调**（outgoing webhook）：实例把消息 POST 到本进程的公开地址。

选择规则 SHALL 可判定：当部署没有可被实例反向访问的公开地址时，SHALL 使用主动连接；
当存在公开地址时 MAY 使用回调。**两者 MUST NOT 同时启用**——同一频道消息被两条路径各处理
一次会产生重复回合。

两种形态 SHALL 产出相同的会话键、相同的发送者归因、相同的回声过滤结果，
使下游的群桥与房间路由不感知形态差异。

#### Scenario: 无公网地址时仍能收

- **WHEN** 部署未配置可被实例反向访问的公开地址
- **THEN** 通道经主动连接接收消息，且回答照常寄回

#### Scenario: 两种形态的下游视图一致

- **WHEN** 同一条频道消息分别经主动连接与回调进入系统
- **THEN** 下游收到的会话键、发送者名与正文一致

#### Scenario: 不重复处理

- **WHEN** 部署同时具备两种形态的条件
- **THEN** 只有一种被启用，同一条消息只产生一个回合

### Requirement: 回调形态必须遵守平台的同步超时窗

回调形态下，实例对外的请求等待时长存在上限（默认 30 秒，可配置）。回合时长可能远超该上限。
因此收到回调 SHALL 立即应答接受，回答 SHALL 在回合结束后经发送接口投递，
MUST NOT 依赖在回调响应体里直接给出回答。

#### Scenario: 长回合不丢回答

- **WHEN** 一个回合耗时超过平台的回调等待上限
- **THEN** 回调已被应答，回答仍在回合结束后出现在频道里
- **THEN** MUST NOT 因等待超时而让该回答凭空消失

#### Scenario: 回调鉴权失败不产生回合

- **WHEN** 回调携带的 token 与会话记录的不一致
- **THEN** 请求被拒，且不产生回合、不记录正文

### Requirement: 会话键由频道与线程决定

会话键 SHALL 取自消息所在的频道；当消息处于某条线程内时，SHALL 取自该线程
（与 Slack 通道「线程即房间」的规则同形），使「一群人在一件事里说话」对应一个会话。

回声与编辑 SHALL NOT 产生回合：bot 自己发出的消息、以及消息编辑事件，
MUST NOT 被当作新的入站消息。

#### Scenario: 线程内对话自成一间

- **WHEN** 同一频道里两条不同线程各有一句消息
- **THEN** 它们落在两个不同的会话，互不串台

#### Scenario: bot 自己的消息不触发回合

- **WHEN** bot 发出的回答出现在频道里
- **THEN** 它不会被当作入站消息再次触发回合

### Requirement: 入站可见面是显式声明的，不默认全量

通道 SHALL 把「bot 参与哪些频道」当成显式配置：默认只处理被明确加入的频道的消息。
MUST NOT 在没有声明的情况下处理实例内所有频道的消息。

理由是这个实例同时承载告警与运维作业面，未经声明的全量入站会让内部运维对话
进入面向外部群聊的房间路由。

#### Scenario: 未被加入的频道不产生回合

- **WHEN** bot 未加入某频道，该频道有消息
- **THEN** 不产生回合

#### Scenario: 加入后开始工作

- **WHEN** 运营者把 bot 加入某频道
- **THEN** 该频道的后续消息按既有回合协议处理
