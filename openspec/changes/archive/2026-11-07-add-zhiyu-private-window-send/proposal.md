# Proposal: add-zhiyu-private-window-send

## Why

私窗只有半边：`zhiyu-room` spec「语境隔离与可见性」要求每个成员与其值守分身之间拥有一条私窗（「陈总在私窗吩咐分身」场景隐含发送面），读面（visibility filter、语境构造器的私窗注入、前端只读抽屉）一期已建，但**发送面从未实现**——全仓没有任何代码路径能写入 `visibility = private:<memberId>` 行（store 默认 shared、POST /messages 无私窗参数、前端抽屉无输入区），生产全部房间 0 条私窗行。spec「私窗不外泄」目前空洞成立（无东西可写故无东西可漏）。走查单 3.2 的正向私窗样本因此不可获得。

## What Changes

- **发送 API**：`POST /api/zhiyu/rooms/:id/private`（成员鉴权、active user seat 要求）：`{content}` → 追加 human 行 `visibility = private:<myUser.id>` → 定向触发该成员自己的值守分身一回合（mode `"private"`），分身应答行同样 `private:<myUser.id>`（对 owner 可读、对他人不可见）。分身缺席（未入场/非 active）→ 409 可读原因，不发假应答。
- **路由器**：`runTurn` 的应答行/相关事件行携带 `visibility = private:<sender.member.id>`（mode=private 时）；广播征询与 @提及解析不参与（私窗是 1:1 车道）；房间日预算闸照常计数（房间开销）、计费照常走分身部署键 settle（usage id 带 `-private` 尾缀可归因）。
- **前端**：私窗抽屉从只读改为带输入区（`POST /private` + 发送后乐观回显按服务端行为权威）。
- **guest 不可达**：guest 无 user seat（`guestSeat` 与 member 闸双重隔离），guest 不可写私窗。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `zhiyu-room`：「语境隔离与可见性」需求补发送面语义（成员 SHALL 能在私窗中与其值守分身交换消息；应答行与吩咐行同为 private 档；guest 不可达；分身缺席如实谢绝），补三场景（私窗交换落 private 档、guest 不可达、分身缺席如实谢绝）。

## Impact

- `gateway/zhiyu/index.js`（新路由一处）；`gateway/zhiyu/room-router.js`（应答行 visibility 按 mode + 私窗车道分支）；
- `web/src/pages/ZhiyuRoomPage.tsx`（私窗抽屉输入区）；
- `scripts/test-zhiyu-*.mjs` 套件补用例；无 schema 变更（visibility 列已存在）；
- 生产面：`POST /api/zhiyu/rooms/:id/private` 新端点（成员鉴权后可达）。
