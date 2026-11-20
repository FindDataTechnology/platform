# zhiyu-im-bridge Specification

## Purpose
萬星·智语三期·IM 群桥：让企微/飞书/Telegram/公众号的群消息走路径到房间（壹座空间），群内的人成为房间的客户，房间的回答寄回群——IM 群成为房间的第四个出入口。

## Requirements

### Requirement: bot↔房间绑定管理

cell 侧 bots 行 SHALL 可额外携带一个 `zhiRoomId`（空 = 行为与绑定出现前逐字节一致）。
绑定由 bot owner 的管理 REST 操作：`PUT/DELETE /api/zhiyu-im-bridge/bots/:botId/room`。非法目标（房间不存在、非本人 bot、非本人房间）SHALL 同形拒绝（404），不泄露存在性。

绑定状态查询 SHALL 同时返回该绑定**当前是否可解析**（绑定房间是否存在）。房间在绑定之后不复存在时（例如被直接删库删除），这条绑定 SHALL 被如实标注为「已失效」，MUST NOT 继续以正常绑定呈现；管理面 SHALL 提供解绑与重新绑定两条出路。

因悬空绑定而发生的入流降级 SHALL NOT 无声：降级 SHALL 留下带稳定标记的结构化日志（可按标记检索/告警），且 SHALL 与管理面上的失效标注指向同一事实。

bots 行 SHALL 另可携带 `zhiAccountId`（团队号，见 `zhiyu-team-account`），与 `zhiRoomId` 互斥：
两者同时存在为非法写入（SHALL 以可读原因拒绝，既有绑定不变）。绑号时群消息 SHALL 经该号解析
target 后落地（`room` 目标落该房；`fleet` 目标由团队前台分诊开房），可解析性判定、失效标注与
降级日志 SHALL 与绑房时同形。

#### Scenario: 为 bot 绑定房间

- **WHEN** bot owner PUT 给自己的 bot 一个属于自己的现存房间的 roomId
- **THEN** 绑定落行；该 bot 的下一条群消息走桥径

#### Scenario: 删除绑定即回旧径

- **WHEN** bot owner DELETE 同一绑定
- **THEN** 下一条群消息回到(bot,chat）一 agent 会话的旧径，无变化残留

#### Scenario: 他人 bot 的绑定状态不可见

- **WHEN** 一个用户 GET 一个不属于自己的 bot 的绑定状态
- **THEN** 与不存在同形（404），不泄露绑定或房间存在性

#### Scenario: 房间没了，绑定不再假装正常

- **WHEN** 一个已绑定的房间被删除，bot owner 查看该 bot 的绑定状态
- **THEN** 状态如实标注为失效，并给出解绑/重新绑定的入口

#### Scenario: 悬空绑定的降级可检索

- **WHEN** 一条群消息抵达一个悬空绑定的 bot
- **THEN** 该次降级产生带稳定标记的结构化日志
- **AND** 该日志与绑定状态查询报出的失效事实一致

#### Scenario: 绑号后群消息由前台分诊

- **WHEN** 一个绑了团队号的 bot 收到一条群消息
- **THEN** 消息经该号的 target 解析落地，访客按既有规则铸 guest 席，回答以既有反输规则回群

#### Scenario: 同时绑房与绑号被拒

- **WHEN** bot owner 在一次写入里同时给出 `zhiRoomId` 与 `zhiAccountId`
- **THEN** 写入被拒并给出可读原因，原绑定保持不变

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

长消息按平台事实上限切段并依次投递；IM 送达失败 SHALL 如实记录（不静默吞）并有限重试，再败则在房间事件流中如实落一条送达失败事件。

送达失败事件的**内容** SHALL 是读者可据此行动的人话摘要（哪个平台、哪条回答没寄到、下一步做什么），MUST NOT 原样携带第三方接口的原始错误串、内部网络地址或凭据痕迹；完整细节 SHALL 留在服务端日志与受权限约束的运维面。

失败事件的措辞 SHALL 按**病因**区分，至少区分两类，因为处置动作不同：

- 出口不被接受（如平台返回「来源 IP 不在允许列表」）：处置是更换出口或改走不依赖出口的出流腿。
- 回复窗口关闭（被动回复通道超窗）：处置是等待下一次入站，或改走可主动发送的出流腿。

两者 MUST NOT 共用一句泛化的「发送失败」。

同一 bot 连续多条回答失败于**同一原因**时，房间事件流 SHALL 收敛呈现，MUST NOT 每条失败各落一行：首条如实落事件，其后在收敛窗口内 SHALL 归并为一条带计数的行（如「N 条未送达」），窗口结束后若无新失败 SHALL 允许重新以首条形态落事件、若有新失败 SHALL 继续归并。原因**改变**时 SHALL 立即落一行新的、说明新原因的事件（不同病因不得被合并成同一个计数）。

送达失败本身 SHALL NOT 使房间停摆：其后的回答照常产生、照常进入房间流，仅在寄回 IM 的这一段失败。

#### Scenario: 长回答被切段寄回 IM

- **WHEN** 一座席回答超过 Telegram 4096 字符上限
- **THEN** 回答被切成有序多段寄到 IM 群

#### Scenario: 失败事件说人话，不带内部细节

- **WHEN** 一个 IM 平台的投递连续重试后仍失败
- **THEN** 房间事件流出现一条说明「哪条回答没寄到、哪个平台、去哪个设置项处理」的人话事件
- **AND** 该事件文本不含内部 IP 地址与厂商原始错误码串

#### Scenario: 出口被拒与窗口关闭说成两件事

- **WHEN** 一条回答因出口地址不被接受而失败，另一条因被动回复窗口已关闭而失败
- **THEN** 两条事件的措辞不同，各自指向对应的处置动作
- **AND** 两者不共用一句泛化文案

#### Scenario: 同因连续失败收敛为一行

- **WHEN** 同一个 bot 连续 10 条回答因同一原因投递失败
- **THEN** 房间事件流内该原因的事件行数远小于 10（首条 + 一条带计数的归并行）
- **AND** 归并行上的计数如实反映未送达条数

#### Scenario: 原因改变另起一行

- **WHEN** 先前的失败原因（如出口地址不被接受）已收敛为一行，随后失败原因变为另一种（如凭据失效）
- **THEN** 立即新增一条说明新原因的事件，不并入旧计数

#### Scenario: 送达失败不影响房间内的回答

- **WHEN** 一个 bot 的 IM 投递持续失败
- **THEN** 房间内智能体的回答照常产出并进入共享流
- **AND** 人类成员之间的对话不受影响

### Requirement: bots 面板的房间挂接面

bots 管理面的 bot 编辑挂接区 SHALL 提供「房间挂接」字段：展示现行绑定状态、允许填 roomId 保存、允许解除；保存后下一次群消息走桥径。

#### Scenario: 面板挂接生效

- **WHEN** bot owner 在面板给 bot 填一个 roomId 并保存
- **THEN** 下一次群消息落该房间

### Requirement: 绑定面如实回答出流能力

bot↔房间绑定状态 SHALL 同时回答**这条腿能不能把答案寄回群**，而不只是「房间在不在」。
能力 SHALL 以稳定枚举表达，至少区分：

- `proactive-ip-gated`——主动发送，但受调用方出口白名单约束（自建应用 `wecom` 的
  `message/send`）。出口地址变化即失效，且失效与凭据无关。
- `passive-window`——只能回复最近一次入站回调携带的一次性 URL（智能机器人 `wecom-bot`
  的 `response_url`），超过窗口就无法主动发送。
- `url-keyed`——凭据在 URL 内、不校验调用方出口（群机器人 Webhook）。
- `none`——该 bot 类型没有任何出流能力。

绑定面 SHALL 同时给出**当前可否寄回**的判断，其判据与真实发送路径同源，MUST NOT 用「绑定存在」
或「房间活着」代替。

#### Scenario: 自建应用腿显示它受出口白名单约束

- **WHEN** bot owner 查看一个 `wecom`（自建应用）bot 的房间挂接状态
- **THEN** 状态里出现 `proactive-ip-gated` 能力与其含义
- **AND** MUST NOT 只显示「已绑定、房间正常」而不提这条腿的发出去依赖出口白名单

#### Scenario: 智能机器人腿显示它只有被动窗口

- **WHEN** bot owner 查看一个 `wecom-bot` bot 的房间挂接状态
- **THEN** 状态里出现 `passive-window` 能力，且说明「超过窗口无法主动发送」
- **AND** 若当前没有活的回复窗口，当前可否寄回 SHALL 如实为「否」

#### Scenario: 能力与房间存活是两个事实

- **WHEN** 一个绑定的房间活着，但这条腿当前寄不回去
- **THEN** 绑定面同时呈现「房间在」与「寄不回」两件事
- **AND** MUST NOT 因为房间活着就把整体状态呈现为正常

### Requirement: 出流腿与入流腿可分离

一个房间的 IM 出流 SHALL 可与入流分开指定：入流由承载回调的 bot 决定，出流 SHALL 可指向另一个
**只负责发送**的通道（群机器人 Webhook），因此「出口地址变了」不再必然意味着「群里收不到回答」。

缺省 SHALL 保持「同一条腿」，MUST NOT 静默改变既有绑定的行为；分离是显式选择，且 SHALL 在绑定面
可见。

当出流腿指向的通道无法入流时（纯出流通道），绑定面 SHALL 明示「此腿只出不进」，避免运维以为
群里发消息会进来。

#### Scenario: 入流走智能机器人、出流走群 Webhook

- **WHEN** bot owner 把一个房间的入流腿设为智能机器人、出流腿设为群机器人 Webhook
- **THEN** 群消息经智能机器人回调进入房间
- **AND** 房间的回答经 Webhook 寄回群，不依赖任何调用方出口白名单

#### Scenario: 出流腿进不去那个群是能力问题，不是配置遗漏

- **WHEN** 出流腿指向一个**不是该群创建者**的自建应用
- **THEN** 平台会拒绝（企微 `86008 you has no privilege to access this chat, created by other agent`）
- **AND** 该拒绝 SHALL 被当作「这条腿进不去这个群」如实呈现，MUST NOT 被读成「配置没配好」

2026-11-19 实测：群由智能机器人创建，把出流腿指向自建应用正是撞在这条上。合法组合是
「入流走某条腿 + 出流走**群 Webhook**」，或「入流与出流同一条腿」。出流腿与群必须是同一
创建者关系——这不是配置项，是平台的权限事实。

#### Scenario: 缺省行为不变

- **WHEN** bot owner 只做了既有的一次绑定、没有指定出流腿
- **THEN** 出流仍走同一条腿，行为与其绑定时逐字节一致

#### Scenario: 纯出流腿被明示

- **WHEN** bot owner 选择一个不能接收消息的通道作为出流腿
- **THEN** 绑定面明示该腿只出不进
- **AND** MUST NOT 让运维以为往群里发消息会进入房间

### Requirement: 新绑定不从历史回灌

绑定（或重绑）建立时，出流游标 SHALL 从房间当前尾部起算，MUST NOT 把房间已有历史倒灌进群。

#### Scenario: 重绑不倒灌历史

- **WHEN** 一个已积累历史的房间被绑定到一个出流通道
- **THEN** 只有绑定之后产生的新回答会被寄出
- **AND** 房间既有历史不会逐条涌向群

#### Scenario: 倒灌时如实记录而不静默

- **WHEN** 由于任何原因，出流试图发送早于绑定时刻的行
- **THEN** 该行为可诊断（日志或事件留痕）
- **AND** MUST NOT 以「发送失败」的泛化形态淹没真实病因
