## Why

智语今天只有 web 面。`miniapp/src` 里没有 zhiyu 任何一处，`app/src` 同样——两个移动端都只能聊天、看定时任务、
看资源，**进不了房间**。而会议、外勤、客户现场恰恰是最需要用智语的地方：人在会议室里，不会打开笔记本进 web。

同时有一个已知的传输障碍：房间的事件流是 SSE（`gateway/zhiyu/index.js` 的 `/api/zhiyu/rooms/:id/events`），
而**小程序不支持 SSE**；网关的 WebSocket 升级又把连接钉在「调用者自己的 cell」上（`gateway/index.js:1356`），
而房间是网关级的跨 cell 对象。所以移动端不是「少个页面」，是**少一条传输**。

这一件把移动端的智语面与那条传输一起补上。

## What Changes

- 新增**移动端智语面**（小程序 + App）：房间列表、房间消息流、在场状态（只读）、按住的语音输入。
- 新增**房间事件流的移动端传输**：小程序与 App 不具备 SSE 时，允许走**短轮询游标**或 WS，但**语义必须与 SSE 完全一致**
  （`after` 游标、断线补读、首屏尾部窗口起播、可见性过滤）。传输方式 SHALL 是实现的细节，不是契约的差异。
- 新增**精简面原则**：移动端只做「进房、看流、说一句」。邀请对话框、私窗抽屉、团队订阅管理、历史窗口授权
  这类重交互 SHALL 以一次性链接深链回 web（复用既有 `share-link`），MUST NOT 在移动端做简化版语义。
- 新增**语音入流**：按住说话 → 转写 → 作为人类消息进入房间流（归属按既有阶梯；转写文本在发送前可编辑）。
- 新增**通知与深链**：房间相关通知经小程序订阅消息 / App 推送抵达，点击直达对应房间与游标位置。
- 新增**访客可用**：widget 令牌与 `share-link` 在移动端同样可进房（guest 席位），权限与 web 一致。
- **不改**：房间的任何既有语义（回合路由、熔断、私窗、可见性、计费、保留期）；web 面；既有 `zhiyu-room` 端点契约。

## Capabilities

### New Capabilities

- `zhiyu-mobile-surface`: 智语的移动端面——与 web 同语义的传输与游标契约（含 SSE 不可用时的降级）、
  精简面的边界与深链回 web、语音入流、通知深链、访客进房、以及小程序/App 生命周期下的恢复语义。

### Modified Capabilities

（无。`zhiyu-room` 的每条行为原样保留；本能力只新增「另两种客户端如何呈现与传输」，不改房间本身。）

## Impact

- **gateway / zhiyu**：新增 `GET /api/zhiyu/rooms/:id/stream`（轻量长轮询：`after` 游标 + 短等待 + 返回增量），
  与既有 SSE 端点**并列**，语义由同一份可见性/游标实现支撑（抽取共用函数，SSE 行为零改）。
- **miniapp**：新增 `src/pages/zhiyu/{list,room}` 两页 + 注册进 `app.config.ts`（静态注册，沿用页面集纪律）；
  新增 `src/lib/zhiyu-client.ts`（游标、去重、补读、轮询退避）；聊天页的录音适配器扩展出「发送到房间」分支。
- **app**：新增 `app/src/app/(tabs)/zhiyu/...`（Expo Router 路由）+ `app/src/lib/zhiyu-client.ts`（与小程序共用契约测试）；
  语音复用 `add-voice-input-mobile` 的适配器。
- **packages/core**：新增与平台无关的房间客户端状态机（`seq` 去重、尾部起播、补读、可见性过滤后的本地视图），
  三端共用；不新增运行时依赖。
- **通知**：小程序订阅消息模板与 App 推送承载 `roomId` + `seq` 深链；沿用既有通知类型集合（不新增未读口径）。
- **测试**：新增 `scripts/test-zhiyu-stream-parity.mjs`（SSE 与轮询在同一消息序列下的产出对比，逐字段相等）、
  `scripts/test-zhiyu-mobile-cursor.mjs`（尾部起播、补读不漏不重、翻页可见性）；真机走查单列。
- **兼容性**：无新 env；既有 SSE 客户端零改动；移动端上线不改变房间的任何服务端行为。
