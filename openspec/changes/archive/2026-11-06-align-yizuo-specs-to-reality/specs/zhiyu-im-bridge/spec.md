## MODIFIED Requirements

### Requirement: bot↔房间绑定管理

cell 侧 bots 行 SHALL 可额外携带一个 `zhiRoomId`（空 = 行为与绑定出现前逐字节一致）。
绑定由 bot owner 的管理 REST 操作：`PUT/DELETE /api/zhiyu-im-bridge/bots/:botId/room`。非法目标（房间不存在、非本人 bot、非本人房间）SHALL 同形拒绝（404），不泄露存在性。

#### Scenario: 为 bot 绑定房间

- **WHEN** bot owner PUT 给自己的 bot 一个属于自己的现存房间的 roomId
- **THEN** 绑定落行；该 bot 的下一条群消息走桥径

#### Scenario: 删除绑定即回旧径

- **WHEN** bot owner DELETE 同一绑定
- **THEN** 下一条群消息回到(bot,chat）一 agent 会话的旧径，无变化残留

#### Scenario: 他人 bot 的绑定状态不可见

- **WHEN** 一个用户 GET 一个不属于自己的 bot 的绑定状态
- **THEN** 与不存在同形（404），不泄露绑定或房间存在性
