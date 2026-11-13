## ADDED Requirements

### Requirement: 可选的房间桥接路由

当 bot 行携带 `zhiRoomId` 时，webhook 入站路径 SHALL 送到 IM 群桥（add-zhiyu-im-bridge）：该 bot 的群消息不再在本 cell 起 agent 会话、而是以人类消息落到绑定房间；当该字段为空时一切行为与桥出现前逐字节一致。桥互相的 Channel/Secret 验证与内容搬迁将已照旧进行，不做任何谓词改变。

#### Scenario: 绑定 bot 的群消息走桥径

- **WHEN** 一个绑定了房间的 bot 收到一条通过验签的群消息
- **THEN** 消息送到桥径（进房间），本 cell 不起该群的新会话

#### Scenario: 未绑定者是逐字节旧行为

- **WHEN** 一个没有 `zhiRoomId` 的 bot 收到同形群消息
- **THEN** 与桥出现前完全一致的行为、无分支
