# Tasks — add-platform-guaranteed-capture

> 执行约定：1 是 2-4 的前置（核对结论定形状）；2-4 三面可并行子代理；5 收口归主代理。

## 1. 前置核对与捕获件

- [x] 1.1 核对 fd-memory `/observe` 的 project 指定能力（person 令牌能否写非 default project）：能则 SDK observe 客户端补可选 project 参（0.1.3）；不能则智语 tap 改走 `/pages` POST observation 页型（平台担保语义等价），design D2 二选一落定
- [x] 1.2 新建 `server/observe-tap.js`：`observeTurnTap()` 薄封装（SDK observeFireAndForget + personTokenFor 缓存复用 + `CELL_MEMORY_OBSERVE_TAP` 回滚杆 + 截断纪律 + 房间 project 分派），全路径 fire-and-forget 永不 throw
- [x] 1.3 单测：配置不全/开关关/令牌铸造失败三态零请求；事件体形状（幂等键、harness、metadata）；截断边界

## 2. chat tap（finishTurn 双载体）

- [x] 2.1 `server/dsh-events.js` finishTurn 定义体接 tap（recordPackUsage 旁，outcome=参数 ?? error 标志，durationMs=T.startedAt 起算）
- [x] 2.2 `server/runtime-bindings.js` 包装层核对：确认包装路径经定义体 tap 即覆盖，不双报（若包装层可能绕过定义体则补第二处）
- [x] 2.3 测试：正常回合落 L0（lane=chat, outcome=ok）；error/aborted 照实；双载体幂等单报；finishTurn 既有输出（done/usage/broadcast）字节不变

## 3. bot tap（handleMessage 结算）

- [x] 3.1 `server/bots.js` 回合 try/finally 收尾接 tap（lane=bot, metadata 含 botId/chatKey, outcome 三态, 门禁扣住的回合同样落底）
- [x] 3.2 测试：成功回合落 L0 含截断对话原料；失败/中止照实；fd-memory 5xx 时回合照常投递

## 4. 智语 tap（room-router 三分支）

- [x] 4.1 `gateway/zhiyu/room-router.js` 回合函数 answered/passed/failed 三分支接 tap（lane=zhiyu, 房主令牌, 房间 project per 1.1 结论, metadata 含 roomId/memberRef）
- [x] 4.2 测试：三分支各落一条；成员个人 default 根零写入（隐私镜像断言）；memoryBlock 既有注入语义零变化

## 5. 收口（主代理）

- [x] 5.1 定向回归：四记忆重指向测试件 + zhiyu-room/bots 既有套件 + ws 相关件全绿
- [x] 5.2 `openspec validate add-platform-guaranteed-capture --strict` 绿
- [x] 5.3 纪律文本降位核验：SDK MEMORY_DISCIPLINE 文本与 chat-memory delta 的新定位一致（handoff 条款保留、note 降位 L1）——文本若需更新走 SDK 0.1.x 版本化（fd-memory 侧小改）
