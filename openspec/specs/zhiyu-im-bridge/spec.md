# zhiyu-im-bridge Specification

## Purpose
萬星·智语三期·IM 群桥：让企微/飞书/Telegram/公众号的群消息走路径到房间（壹座空间），群内的人成为房间的客户，房间的回答寄回群——IM 群成为房间的第四个出入口。

## Requirements

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

### Requirement: 入流造座与消息落房

绑定的 bot 收到一条通过平台验证的群消息 SHALL 以人类消息落到房间：发送者按 `im_<chatKey>_<imUserId>` 哈希铸一个 guest 席（kind=guest），display=IM 显示名，成员 meta 记 `im:{platform,chatKey,senderName}`；随后走房间既有回合路由——@点名、广播可 pass、熔断、应答上限、日预算，**路由零改造**。

#### Scenario: 群友一条消息落房

- **WHEN** 一名 IM 群友在绑定群里发「@接待分身 你好」
- **THEN** 房间多出一条该 sender 的 guest 消息，并触发房间的回合路由

#### Scenario: 同一 sender 续发不重铸席位

- **WHEN** 同一人再发一条群消息
- **THEN** 复用同一 guest 席，不复制成员行

### Requirement: 房间反输订阅与回写

桥 SHALL 在 gateway 侧按 roomId 订阅房间事件流：`kind=agent` 的回答与选定系统事件（room_ended、budget_exhausted、needs_you）回写 IM，消息前随座署名「智库副驾：」「<名>(代 X 出席)」；成员 meta 记 `im` 的行 SHALL NOT 回写 IM（已是群里的原话，防回响）。

#### Scenario: 分身回答回到群

- **WHEN** 值班分身落了一条回答
- **THEN** IM 群收到一条「智库副驾：<回答〉<页面>」消息

#### Scenario: IM 自己的消息不回到群

- **WHEN** 一条 IM sender 的 guest 消息落房后出现
- **THEN** 该消息不回寄 IM 群

#### Scenario: 房间结束的告示入群

- **WHEN** 房间结束（空闲自动或主办手动）
- **THEN** IM 群收到「本次会话已结束」的告知消息

### Requirement: 访客范围与计费照常

IM 访客在房间里的事项（matters）SHALL 按一期约定携带 scopeSeed=`room:<roomId>:<senderRef>`；应答 SHALL 按应答座位自己的部署计费键结算，usage id 带 guest scope。日预算闸与应答上限对 IM 流量同样生效。

#### Scenario: guest 点名应答计座位部署账

- **WHEN** IM 访客点名一个服务智能体并被应答
- **THEN** 计费落到该座的部署键，`pack_host_settlements` 出现带 guest 后缀行

### Requirement: IM 侧切段与送达如实

长消息按平台事实上限切段并依次投递；IM 送达失败 SHALL 如实记录（不静默吞）并有限重试一次，再败则在房间事件流中如实落一条送达失败事件。

#### Scenario: 长回答被切段寄回 IM

- **WHEN** 一座席回答超过 Telegram 4096 字符上限
- **THEN** 回答被切成有序多段寄到 IM 群

### Requirement: bots 面板的房间挂接面

bots 管理面的 bot 编辑挂接区 SHALL 提供「房间挂接」字段：展示现行绑定状态、允许填 roomId 保存、允许解除；保存后下一次群消息走桥径。

#### Scenario: 面板挂接生效

- **WHEN** bot owner 在面板给 bot 填一个 roomId 并保存
- **THEN** 下一次群消息落该房间
