## Why

房间已有三个出入口：站内、网页嵌入、进房链接。IM 群聊（企微/飞书/Telegram）是商家与用户最常住的地方，但目前的 bot 只有"一个群 = 一个 agent 会话"的独立路子，看不到房间里的人和分身。三期把 IM 群收编为房间的第四个出入口——四个平台适配器与 bot-webhook 链路全部沿用。

## What Changes

- **绑定**：cell 侧 `bots.zhiRoomId` 新列（空 = 老行为逐字节不变）。绑定后该 bot 的群消息改走"进群入房"桥径。
- **入流（IM → 房间）**：群消息验证解析后，以人类消息落房；发送者按 `im_<chatKey>_<imUserId>` 哈希铸 guest 席，display=IM 显示名，成员 meta 记 `im:{platform,chatKey,senderName}`。后继主房间既有回合路由（@点名/广播可过/熔断/上限/日预算），路由零改造。
- **反输（房间 → IM）**：桥订阅房间事件流，`kind=agent` 回答与选定系统事件（结束/预算触顶/呼叫回呼）寄回 IM，消息前随座署名；来自 IM 的消息不回写 IM（防回响）；长消息按平台事实上限切段投递。
- **访客照常**：IM 访客的访客范围（scopeSeed）与一期约定一致（`room:<roomId>:<senderRef>`）；事项设施不新增特殊处理。
- **管理口**：`PUT/DELETE /api/zhiyu/im-bridge/bots/:botId/room`（bot owner 操作）；bots 面板加"房间挂接"可选栏目。
- **BREAKING（温和）**：无。

## Capabilities

### New Capabilities

- `zhiyu-im-bridge`: bot↔room 绑定、群星对话落房造座、房间反输订阅回写、绑定管理 REST、面板挂栏的 IM 群桥。

### Modified Capabilities

- `social-bot-channels`: 入站路由点新加一条"且仅当绑定存在时走桥"规则；删绑定即无损回旧径;适配器契约未动。
- `zhiyu-room`: guest 类补一个来源标记能力（`im`:平台/群聊/发送人）。

## Impact

- 新增：`gateway/zhiyu/im-bridge.js`（入流路由+订阅回写）、cell 侧 `server/zhiyu-im-bridge.js`（入站选径）、`bots` 表 migration。
- 复用：房间回合路由/熔断/计费/host-settle/未读通知全链零改动。
- 台账：发布 §15;`ZHIYU_IM_BRIDGE_*` 默认闯关开。
